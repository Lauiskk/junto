/**
 * Captura de audio POR PROCESSO no Windows.
 *
 * Este arquivo existe por causa de um problema concreto de privacidade: ao
 * compartilhar apenas UMA JANELA, o app transmitia o audio do sistema inteiro —
 * numa sessao real, a chamada de Discord do usuario foi ouvida por quem estava
 * assistindo. Nao ha API em JavaScript que resolva isso.
 *
 * O Windows resolve desde o build 20348: ActivateAudioInterfaceAsync com
 * VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK captura o audio renderizado por um
 * processo (e seus filhos) — ou, invertendo o modo, tudo MENOS aquele processo.
 *
 * ---------------------------------------------------------------------------
 * Por que existe um mixer aqui dentro
 * ---------------------------------------------------------------------------
 *
 * Os parametros de ativacao carregam EXATAMENTE UM TargetProcessId. Isso torna
 * a exclusao impossivel de ampliar: "tudo menos o Junto E o Discord" nao tem
 * como ser pedido. Ela precisa ser montada pelo outro lado — uma captura
 * INCLUDE por aplicativo que o usuario NAO silenciou, somadas aqui.
 *
 * Duas necessidades reais empurraram para isso:
 *
 *  1. Silenciar mais de um aplicativo. Antes so dava para escolher um.
 *  2. Nao devolver a propria sala. O app toca a voz de cada espectador pelos
 *     alto-falantes; um loopback comum captura isso e manda de volta, e todo
 *     mundo se ouve com atraso. O proprio processo precisa estar SEMPRE fora.
 *
 * Referencias: sample ApplicationLoopback da Microsoft, e o audiocap do golive
 * (github.com/Nem-Tudo/group-sharescreen), que documenta bem essa inversao.
 *
 * ---------------------------------------------------------------------------
 * Sobre versao do Windows
 * ---------------------------------------------------------------------------
 *
 * Nao ha checagem de build aqui, de proposito. A Microsoft documenta o
 * requisito como build 20348 — numero que se le como "so Windows 11", por ser
 * do Server 2022 — mas o que de fato falha no Windows 10 e GetMixFormat /
 * IsFormatSupported, que retornam E_NOTIMPL. Este arquivo nunca chama nenhum
 * dos dois: o formato e DECLARADO, nao negociado. Entao a resposta vem de
 * tentar: se a ativacao for recusada, quem chama cai no loopback comum.
 */

#include <napi.h>

#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <timeapi.h>
#include <tlhelp32.h>
#include <wrl/implements.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

namespace {

/**
 * Formato fixo, montado a mao.
 *
 * Aqui esta a pegadinha que quebra qualquer implementacao ingenua: neste caminho
 * de ativacao, GetMixFormat() retorna E_NOTIMPL. Nao ha formato para consultar —
 * e preciso declarar um. 48 kHz estereo 16-bit e exatamente o que o WebRTC/Opus
 * consome do outro lado, entao nao ha reamostragem no meio.
 */
constexpr WORD kChannels = 2;
constexpr DWORD kSampleRate = 48000;
constexpr WORD kBitsPerSample = 16;

/** Cadencia do mixer. 10 ms e o quantum classico de audio em tempo real. */
constexpr int kTickMs = 10;
constexpr size_t kFramesPerTick = kSampleRate * kTickMs / 1000;  // 480
constexpr size_t kSamplesPerTick = kFramesPerTick * kChannels;   // 960

/**
 * Teto da fila de cada fonte, em amostras (~200 ms).
 *
 * O mixer roda no relogio do sistema e as capturas no relogio da placa de som;
 * os dois nao batem exatamente. Se uma fonte adianta, a fila cresce e vira
 * latencia — descartar o mais antigo devolve a sincronia perdendo alguns
 * milissegundos, que e o menor preco disponivel.
 */
constexpr size_t kMaxQueueSamples = kSampleRate * kChannels / 5;

WAVEFORMATEX MakeFormat() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = kBitsPerSample;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;
  return format;
}

/** ActivateAudioInterfaceAsync e assincrono; isto transforma em espera simples. */
class ActivationHandler
    : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, FtmBase,
                          IActivateAudioInterfaceCompletionHandler> {
 public:
  ActivationHandler() : done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}

  ~ActivationHandler() {
    if (done_) CloseHandle(done_);
  }

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activateResult = E_UNEXPECTED;
    ComPtr<IUnknown> activated;
    HRESULT hr = operation->GetActivateResult(&activateResult, &activated);
    result_ = SUCCEEDED(hr) ? activateResult : hr;
    if (SUCCEEDED(result_)) activated.As(&client_);
    SetEvent(done_);
    return S_OK;
  }

  HRESULT Wait(DWORD timeoutMs) {
    if (WaitForSingleObject(done_, timeoutMs) != WAIT_OBJECT_0) return E_FAIL;
    return result_;
  }

  ComPtr<IAudioClient> client() const { return client_; }

 private:
  HANDLE done_ = nullptr;
  HRESULT result_ = E_UNEXPECTED;
  ComPtr<IAudioClient> client_;
};

HRESULT StartClient(DWORD pid, bool includeProcessTree, ComPtr<IAudioClient>& outClient) {
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      includeProcessTree ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                         : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activateParams{};
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof(params);
  activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto handler = Microsoft::WRL::Make<ActivationHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;

  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                           __uuidof(IAudioClient), &activateParams,
                                           handler.Get(), &operation);
  if (FAILED(hr)) return hr;

  hr = handler->Wait(3000);
  if (FAILED(hr)) return hr;

  ComPtr<IAudioClient> client = handler->client();
  if (!client) return E_FAIL;

  WAVEFORMATEX format = MakeFormat();
  // 200 ms de buffer: folga suficiente para o loop de leitura nao perder pacote
  // se a thread for preemptada, sem adicionar latencia perceptivel.
  const REFERENCE_TIME bufferDuration = 2000000;

  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                          bufferDuration, 0, &format, nullptr);
  if (FAILED(hr)) return hr;

  outClient = client;
  return S_OK;
}

// ---------------------------------------------------------------------------
// Uma fonte de audio
// ---------------------------------------------------------------------------

/**
 * Uma captura, com sua propria thread e sua propria fila.
 *
 * A fila existe porque as fontes nao chegam alinhadas: um aplicativo em
 * silencio nao entrega pacote NENHUM (nao entrega silencio), entao esperar
 * todas as fontes travaria o mixer no primeiro app calado.
 */
struct Source {
  DWORD pid = 0;
  bool include = true;
  std::thread thread;
  std::atomic<bool> running{false};
  std::mutex mutex;
  std::deque<int16_t> queue;
  std::atomic<bool> failed{false};

  void Push(const int16_t* samples, size_t count) {
    std::lock_guard<std::mutex> lock(mutex);
    queue.insert(queue.end(), samples, samples + count);
    if (queue.size() > kMaxQueueSamples) {
      queue.erase(queue.begin(), queue.begin() + (queue.size() - kMaxQueueSamples));
    }
  }

  /** Retira ate `count` amostras; o resto do destino fica como estava (zero). */
  size_t Take(int16_t* out, size_t count) {
    std::lock_guard<std::mutex> lock(mutex);
    const size_t take = std::min(count, queue.size());
    for (size_t i = 0; i < take; ++i) out[i] = queue[i];
    queue.erase(queue.begin(), queue.begin() + take);
    return take;
  }
};

struct CaptureState {
  std::mutex mutex;
  std::vector<std::unique_ptr<Source>> sources;

  std::thread pump;
  std::atomic<bool> running{false};
  Napi::ThreadSafeFunction tsfn;
  std::string lastError;
  /** Nenhuma fonte conseguiu ativar — quem chama precisa saber para cair fora. */
  std::atomic<bool> anyStarted{false};
};

CaptureState g_capture;

void SourceLoop(Source* source) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool comInitialized = SUCCEEDED(hr);

  ComPtr<IAudioClient> client;
  hr = StartClient(source->pid, source->include, client);
  if (FAILED(hr)) {
    source->failed = true;
    {
      std::lock_guard<std::mutex> lock(g_capture.mutex);
      g_capture.lastError = "falha ao ativar a captura do processo " +
                            std::to_string(source->pid) + " (HRESULT " +
                            std::to_string(static_cast<long>(hr)) + ")";
    }
    if (comInitialized) CoUninitialize();
    return;
  }

  ComPtr<IAudioCaptureClient> capture;
  hr = client->GetService(__uuidof(IAudioCaptureClient), &capture);
  if (SUCCEEDED(hr)) hr = client->Start();
  if (FAILED(hr)) {
    source->failed = true;
    if (comInitialized) CoUninitialize();
    return;
  }

  g_capture.anyStarted = true;

  while (source->running) {
    UINT32 packetFrames = 0;
    if (FAILED(capture->GetNextPacketSize(&packetFrames))) break;

    if (packetFrames == 0) {
      // Polling de 10 ms: latencia irrelevante para audio e muito mais simples
      // de acertar do que o caminho por evento.
      Sleep(kTickMs);
      continue;
    }

    while (packetFrames > 0 && source->running) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;

      const size_t samples = static_cast<size_t>(frames) * kChannels;
      if (samples > 0) {
        // AUDCLNT_BUFFERFLAGS_SILENT significa "o processo nao esta emitindo
        // som"; o buffer pode conter lixo e deve ser tratado como silencio.
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          std::vector<int16_t> zeros(samples, 0);
          source->Push(zeros.data(), samples);
        } else {
          source->Push(reinterpret_cast<const int16_t*>(data), samples);
        }
      }

      capture->ReleaseBuffer(frames);
      if (FAILED(capture->GetNextPacketSize(&packetFrames))) break;
    }
  }

  client->Stop();
  if (comInitialized) CoUninitialize();
}

/**
 * O mixer.
 *
 * Roda numa cadencia propria (10 ms) e soma o que cada fonte tiver entregue.
 * Fonte sem nada na fila contribui silencio — que e o comportamento certo: um
 * aplicativo calado nao deve segurar o audio dos outros.
 *
 * A soma e feita em int32 e so entao limitada, para que duas fontes altas ao
 * mesmo tempo distorcam no limite em vez de dar a volta no numero (que soaria
 * como um estalo, nao como saturacao).
 */
void PumpLoop() {
  /**
   * Um milissegundo de resolucao de timer enquanto durar a captura.
   *
   * O padrao do Windows e ~15,6 ms. Com ele, um `sleep_until` de 10 ms dorme 15,6,
   * o alvo fica para tras a cada volta e o laco passa a disparar em rajada para
   * recuperar o atraso — medido: 390 blocos em 3 s, quando o certo sao 300.
   *
   * Isso NAO e cosmetico. O timestamp da trilha do lado do renderer avanca pela
   * contagem de amostras, entao emitir 30% a mais que o tempo real faz o audio
   * adiantar progressivamente em relacao ao video. Numa sessao de duas horas o
   * desvio seria enorme.
   */
  timeBeginPeriod(1);

  auto next = std::chrono::steady_clock::now();
  std::vector<int32_t> mix(kSamplesPerTick);
  std::vector<int16_t> scratch(kSamplesPerTick);
  std::vector<int16_t> out(kSamplesPerTick);

  while (g_capture.running) {
    next += std::chrono::milliseconds(kTickMs);

    /**
     * Se ainda assim o alvo ficar muito para tras (maquina sob carga pesada),
     * reancora em vez de disparar em rajada. Perde-se o audio daquele intervalo,
     * que ja tinha se perdido de qualquer forma — recuperar emitindo rapido
     * demais so transformaria um engasgo momentaneo num descompasso permanente.
     */
    const auto agora = std::chrono::steady_clock::now();
    if (next < agora - std::chrono::milliseconds(50)) next = agora;

    std::this_thread::sleep_until(next);

    std::fill(mix.begin(), mix.end(), 0);

    {
      std::lock_guard<std::mutex> lock(g_capture.mutex);
      for (auto& source : g_capture.sources) {
        std::fill(scratch.begin(), scratch.end(), 0);
        source->Take(scratch.data(), kSamplesPerTick);
        for (size_t i = 0; i < kSamplesPerTick; ++i) mix[i] += scratch[i];
      }
    }

    for (size_t i = 0; i < kSamplesPerTick; ++i) {
      out[i] = static_cast<int16_t>(std::clamp(mix[i], -32768, 32767));
    }

    const size_t bytes = kSamplesPerTick * sizeof(int16_t);
    auto* copy = new BYTE[bytes];
    memcpy(copy, out.data(), bytes);

    auto status = g_capture.tsfn.BlockingCall(
        copy, [bytes](Napi::Env env, Napi::Function callback, BYTE* payload) {
          auto buffer = Napi::Buffer<uint8_t>::Copy(env, payload, bytes);
          delete[] payload;
          callback.Call({buffer});
        });
    if (status != napi_ok) {
      delete[] copy;
      break;
    }
  }

  timeEndPeriod(1);
  g_capture.tsfn.Release();
}

void StopAllSources() {
  std::vector<std::unique_ptr<Source>> doomed;
  {
    std::lock_guard<std::mutex> lock(g_capture.mutex);
    doomed.swap(g_capture.sources);
  }
  for (auto& source : doomed) {
    source->running = false;
    if (source->thread.joinable()) source->thread.join();
  }
}

void AddSource(DWORD pid, bool include) {
  auto source = std::make_unique<Source>();
  source->pid = pid;
  source->include = include;
  source->running = true;
  Source* raw = source.get();
  {
    std::lock_guard<std::mutex> lock(g_capture.mutex);
    g_capture.sources.push_back(std::move(source));
  }
  raw->thread = std::thread(SourceLoop, raw);
}

// ---------------------------------------------------------------------------
// Sessoes de audio
// ---------------------------------------------------------------------------

std::wstring ExecutableForPid(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return L"";

  wchar_t path[MAX_PATH] = {};
  DWORD size = MAX_PATH;
  std::wstring result;
  if (QueryFullProcessImageNameW(process, 0, path, &size)) {
    std::wstring full(path, size);
    const size_t slash = full.find_last_of(L'\\');
    result = slash == std::wstring::npos ? full : full.substr(slash + 1);
  }
  CloseHandle(process);
  return result;
}

std::string ToUtf8(const std::wstring& text) {
  if (text.empty()) return "";
  const int needed =
      WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                          nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(),
                      needed, nullptr, nullptr);
  return out;
}

/**
 * Nossa arvore de processos: o PID deste processo mais todos os descendentes.
 *
 * Isto NAO e detalhe. O Chromium nao renderiza audio no processo principal — ele
 * usa um processo filho de servico de audio. Excluir so o PID principal deixaria
 * o proprio som do app passar, que e exatamente o eco que se quer evitar: o app
 * toca a voz de cada espectador, captura de volta, e todos se ouvem com atraso.
 *
 * Medido nesta maquina: o Electron roda com quatro processos ao mesmo tempo.
 *
 * O modo EXCLUDE do Windows resolveria sozinho (ele cobre a arvore), mas nao da
 * para excluir mais de um alvo — e silenciar varios apps exige o modo INCLUDE,
 * onde a filtragem passa a ser nossa.
 */
std::vector<DWORD> ProcessTree(DWORD root) {
  std::vector<DWORD> tree{root};

  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return tree;

  std::vector<std::pair<DWORD, DWORD>> filhoPai;  // (pid, ppid)
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      filhoPai.emplace_back(entry.th32ProcessID, entry.th32ParentProcessID);
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);

  // Varredura repetida ate estabilizar: cobre netos e bisnetos sem montar
  // um grafo, e a lista de processos de uma maquina e pequena.
  bool cresceu = true;
  while (cresceu) {
    cresceu = false;
    for (const auto& [pid, ppid] : filhoPai) {
      if (std::find(tree.begin(), tree.end(), pid) != tree.end()) continue;
      if (std::find(tree.begin(), tree.end(), ppid) == tree.end()) continue;
      tree.push_back(pid);
      cresceu = true;
    }
  }

  return tree;
}

struct SessionInfo {
  DWORD pid;
  std::string executable;
};

/**
 * Quais processos estao com uma stream de audio aberta agora.
 *
 * E a lista sobre a qual a captura age — porque stream e a unica coisa que ha
 * para deixar de fora. O seletor da interface mostra JANELAS, que e o que uma
 * pessoa reconhece; os dois se encontram pelo nome do executavel.
 */
std::vector<SessionInfo> EnumerateSessions(std::string& error) {
  std::vector<SessionInfo> sessions;

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool comInitialized = SUCCEEDED(hr);

  ComPtr<IMMDeviceEnumerator> enumerator;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                        IID_PPV_ARGS(&enumerator));
  if (SUCCEEDED(hr)) {
    ComPtr<IMMDevice> device;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (SUCCEEDED(hr)) {
      ComPtr<IAudioSessionManager2> manager;
      hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                            reinterpret_cast<void**>(manager.GetAddressOf()));
      if (SUCCEEDED(hr)) {
        ComPtr<IAudioSessionEnumerator> list;
        hr = manager->GetSessionEnumerator(&list);
        if (SUCCEEDED(hr)) {
          int count = 0;
          list->GetCount(&count);
          for (int i = 0; i < count; ++i) {
            ComPtr<IAudioSessionControl> control;
            if (FAILED(list->GetSession(i, &control))) continue;
            ComPtr<IAudioSessionControl2> control2;
            if (FAILED(control.As(&control2))) continue;
            // Os sons do proprio Windows nao pertencem a aplicativo nenhum e
            // nao aparecem no seletor; deixa-los de fora evita uma entrada
            // fantasma que ninguem sabe o que e.
            if (control2->IsSystemSoundsSession() == S_OK) continue;

            DWORD pid = 0;
            if (FAILED(control2->GetProcessId(&pid)) || pid == 0) continue;

            sessions.push_back({pid, ToUtf8(ExecutableForPid(pid))});
          }
        }
      }
    }
  }

  if (FAILED(hr)) {
    error = "falha ao listar sessoes de audio (HRESULT " +
            std::to_string(static_cast<long>(hr)) + ")";
  }

  if (comInitialized) CoUninitialize();
  return sessions;
}

// ---------------------------------------------------------------------------
// Superficie JavaScript
// ---------------------------------------------------------------------------

/**
 * HWND -> PID.
 *
 * O id de fonte do Electron para janelas e "window:<HWND>:0". Isso permite ligar
 * a janela que a pessoa escolheu ao processo dono dela — entao escolher o que
 * compartilhar ja define de quem e o audio, sem um segundo seletor onde daria
 * para errar.
 */
Napi::Value PidFromWindowHandle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "esperado o id da fonte").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string sourceId = info[0].As<Napi::String>();
  // Formato: window:<handle>:<index>
  const size_t first = sourceId.find(':');
  if (first == std::string::npos) return env.Null();
  const size_t second = sourceId.find(':', first + 1);
  const std::string handleText = sourceId.substr(
      first + 1, second == std::string::npos ? std::string::npos : second - first - 1);

  unsigned long long handleValue = 0;
  try {
    handleValue = std::stoull(handleText);
  } catch (...) {
    return env.Null();
  }

  HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(handleValue));
  if (!IsWindow(hwnd)) return env.Null();

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == 0) return env.Null();

  return Napi::Number::New(env, static_cast<double>(pid));
}

Napi::Value CurrentProcessId(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), static_cast<double>(GetCurrentProcessId()));
}

/** Este processo e todos os filhos — o conjunto que nunca deve ser capturado. */
Napi::Value OwnProcessTree(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto tree = ProcessTree(GetCurrentProcessId());
  Napi::Array out = Napi::Array::New(env, tree.size());
  for (size_t i = 0; i < tree.size(); ++i) {
    out.Set(static_cast<uint32_t>(i), Napi::Number::New(env, static_cast<double>(tree[i])));
  }
  return out;
}

Napi::Value ListAudioSessions(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string error;
  auto sessions = EnumerateSessions(error);
  if (!error.empty()) {
    std::lock_guard<std::mutex> lock(g_capture.mutex);
    g_capture.lastError = error;
  }

  Napi::Array out = Napi::Array::New(env, sessions.size());
  for (size_t i = 0; i < sessions.size(); ++i) {
    Napi::Object item = Napi::Object::New(env);
    item.Set("pid", Napi::Number::New(env, static_cast<double>(sessions[i].pid)));
    item.Set("executable", Napi::String::New(env, sessions[i].executable));
    out.Set(static_cast<uint32_t>(i), item);
  }
  return out;
}

std::vector<DWORD> ReadPidArray(const Napi::Value& value) {
  std::vector<DWORD> pids;
  if (!value.IsArray()) return pids;
  Napi::Array array = value.As<Napi::Array>();
  for (uint32_t i = 0; i < array.Length(); ++i) {
    Napi::Value item = array.Get(i);
    if (item.IsNumber()) pids.push_back(static_cast<DWORD>(item.As<Napi::Number>().Uint32Value()));
  }
  return pids;
}

/**
 * startCapture({ excludePid?, includePids? }, callback)
 *
 * `excludePid` e o caminho rapido e o padrao: uma captura so, "tudo menos este
 * processo". Serve para o caso comum — nao devolver a propria sala.
 *
 * `includePids` e o caminho de montagem: uma captura por aplicativo, somadas.
 * So e necessario quando ha mais de um processo a deixar de fora, que e
 * justamente o que a API do Windows nao aceita pedir de uma vez.
 */
Napi::Value StartCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_capture.running) {
    Napi::Error::New(env, "ja existe uma captura em andamento").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "esperado (opcoes, callback)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object options = info[0].As<Napi::Object>();
  const bool hasExclude = options.Has("excludePid") && options.Get("excludePid").IsNumber();
  std::vector<DWORD> includePids = ReadPidArray(options.Get("includePids"));

  if (!hasExclude && includePids.empty()) {
    Napi::TypeError::New(env, "informe excludePid ou includePids")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  {
    std::lock_guard<std::mutex> lock(g_capture.mutex);
    g_capture.lastError.clear();
  }
  g_capture.anyStarted = false;
  g_capture.tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(),
                                                 "junto-audio-capture", 0, 1);
  g_capture.running = true;

  if (hasExclude) {
    AddSource(static_cast<DWORD>(options.Get("excludePid").As<Napi::Number>().Uint32Value()),
              false);
  } else {
    for (DWORD pid : includePids) AddSource(pid, true);
  }

  if (g_capture.pump.joinable()) g_capture.pump.join();
  g_capture.pump = std::thread(PumpLoop);

  return Napi::Boolean::New(env, true);
}

/**
 * Troca o conjunto de aplicativos capturados sem parar o audio.
 *
 * Aplicativos comecam e param de tocar o tempo todo: quem abre o Spotify no
 * meio da sessao precisa passar a ser ouvido, e quem fecha precisa sumir sem
 * deixar uma thread pendurada. So as diferencas sao mexidas — as fontes que
 * continuam nao sentem nada.
 */
Napi::Value SetIncludePids(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_capture.running) return Napi::Boolean::New(env, false);
  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "esperado um array de pids").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::vector<DWORD> desired = ReadPidArray(info[0]);
  std::vector<std::unique_ptr<Source>> doomed;

  {
    std::lock_guard<std::mutex> lock(g_capture.mutex);
    for (auto it = g_capture.sources.begin(); it != g_capture.sources.end();) {
      const bool keep = std::find(desired.begin(), desired.end(), (*it)->pid) != desired.end();
      // Uma fonte que falhou ao ativar tambem sai: o processo pode ter morrido,
      // e mante-la seria carregar uma thread que nunca vai entregar nada.
      if (keep && !(*it)->failed) {
        ++it;
      } else {
        doomed.push_back(std::move(*it));
        it = g_capture.sources.erase(it);
      }
    }
  }

  for (auto& source : doomed) {
    source->running = false;
    if (source->thread.joinable()) source->thread.join();
  }

  std::vector<DWORD> existing;
  {
    std::lock_guard<std::mutex> lock(g_capture.mutex);
    for (auto& source : g_capture.sources) existing.push_back(source->pid);
  }
  for (DWORD pid : desired) {
    if (std::find(existing.begin(), existing.end(), pid) == existing.end()) {
      AddSource(pid, true);
    }
  }

  return Napi::Boolean::New(env, true);
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  g_capture.running = false;
  if (g_capture.pump.joinable()) g_capture.pump.join();
  StopAllSources();
  return Napi::Boolean::New(env, true);
}

Napi::Value LastError(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(g_capture.mutex);
  if (g_capture.lastError.empty()) return env.Null();
  return Napi::String::New(env, g_capture.lastError);
}

/** Alguma fonte chegou a ativar? Se nao, quem chama precisa cair no plano B. */
Napi::Value Ativa(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_capture.anyStarted.load());
}

Napi::Value FormatInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  out.Set("sampleRate", Napi::Number::New(env, kSampleRate));
  out.Set("channels", Napi::Number::New(env, kChannels));
  out.Set("bitsPerSample", Napi::Number::New(env, kBitsPerSample));
  return out;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("pidFromWindowId", Napi::Function::New(env, PidFromWindowHandle));
  exports.Set("currentProcessId", Napi::Function::New(env, CurrentProcessId));
  exports.Set("ownProcessTree", Napi::Function::New(env, OwnProcessTree));
  exports.Set("listAudioSessions", Napi::Function::New(env, ListAudioSessions));
  exports.Set("startCapture", Napi::Function::New(env, StartCapture));
  exports.Set("setIncludePids", Napi::Function::New(env, SetIncludePids));
  exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
  exports.Set("lastError", Napi::Function::New(env, LastError));
  exports.Set("capturando", Napi::Function::New(env, Ativa));
  exports.Set("formatInfo", Napi::Function::New(env, FormatInfo));
  return exports;
}

}  // namespace

NODE_API_MODULE(junto_audio, Init)
