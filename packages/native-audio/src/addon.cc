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
 * Referencia: sample ApplicationLoopback da Microsoft.
 */

#include <napi.h>

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <wrl/implements.h>

#include <atomic>
#include <string>
#include <thread>

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

/** Estado global: existe no maximo uma captura por vez. */
struct CaptureState {
  std::thread thread;
  std::atomic<bool> running{false};
  Napi::ThreadSafeFunction tsfn;
  std::string lastError;
};

CaptureState g_capture;

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

void CaptureLoop(DWORD pid, bool includeProcessTree) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool comInitialized = SUCCEEDED(hr);

  ComPtr<IAudioClient> client;
  hr = StartClient(pid, includeProcessTree, client);
  if (FAILED(hr)) {
    g_capture.lastError = "falha ao ativar a captura do processo (HRESULT " +
                          std::to_string(static_cast<long>(hr)) + ")";
    g_capture.running = false;
    g_capture.tsfn.Release();
    if (comInitialized) CoUninitialize();
    return;
  }

  ComPtr<IAudioCaptureClient> capture;
  hr = client->GetService(__uuidof(IAudioCaptureClient), &capture);
  if (SUCCEEDED(hr)) hr = client->Start();
  if (FAILED(hr)) {
    g_capture.lastError = "falha ao iniciar a captura";
    g_capture.running = false;
    g_capture.tsfn.Release();
    if (comInitialized) CoUninitialize();
    return;
  }

  const WORD blockAlign = kChannels * kBitsPerSample / 8;

  while (g_capture.running) {
    UINT32 packetFrames = 0;
    if (FAILED(capture->GetNextPacketSize(&packetFrames))) break;

    if (packetFrames == 0) {
      // Polling de 10 ms: latencia irrelevante para audio e muito mais simples
      // de acertar do que o caminho por evento.
      Sleep(10);
      continue;
    }

    while (packetFrames > 0 && g_capture.running) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;

      const size_t bytes = static_cast<size_t>(frames) * blockAlign;
      if (bytes > 0) {
        // AUDCLNT_BUFFERFLAGS_SILENT significa "o processo nao esta emitindo
        // som"; o buffer pode conter lixo e deve ser tratado como silencio.
        const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
        auto* copy = new BYTE[bytes];
        if (silent) {
          memset(copy, 0, bytes);
        } else {
          memcpy(copy, data, bytes);
        }

        auto status = g_capture.tsfn.BlockingCall(
            copy, [bytes](Napi::Env env, Napi::Function callback, BYTE* payload) {
              auto buffer = Napi::Buffer<uint8_t>::Copy(env, payload, bytes);
              delete[] payload;
              callback.Call({buffer});
            });
        if (status != napi_ok) delete[] copy;
      }

      capture->ReleaseBuffer(frames);
      if (FAILED(capture->GetNextPacketSize(&packetFrames))) break;
    }
  }

  client->Stop();
  g_capture.running = false;
  g_capture.tsfn.Release();
  if (comInitialized) CoUninitialize();
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

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_capture.running) {
    Napi::Error::New(env, "ja existe uma captura em andamento")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsBoolean() ||
      !info[2].IsFunction()) {
    Napi::TypeError::New(env, "esperado (pid, incluirProcesso, callback)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const DWORD pid = static_cast<DWORD>(info[0].As<Napi::Number>().Uint32Value());
  const bool include = info[1].As<Napi::Boolean>();

  g_capture.lastError.clear();
  g_capture.tsfn = Napi::ThreadSafeFunction::New(env, info[2].As<Napi::Function>(),
                                                 "junto-audio-capture", 0, 1);
  g_capture.running = true;

  if (g_capture.thread.joinable()) g_capture.thread.join();
  g_capture.thread = std::thread(CaptureLoop, pid, include);

  return Napi::Boolean::New(env, true);
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  g_capture.running = false;
  if (g_capture.thread.joinable()) g_capture.thread.join();
  return Napi::Boolean::New(env, true);
}

Napi::Value LastError(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_capture.lastError.empty()) return env.Null();
  return Napi::String::New(env, g_capture.lastError);
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
  exports.Set("startCapture", Napi::Function::New(env, StartCapture));
  exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
  exports.Set("lastError", Napi::Function::New(env, LastError));
  exports.Set("formatInfo", Napi::Function::New(env, FormatInfo));
  return exports;
}

}  // namespace

NODE_API_MODULE(junto_audio, Init)
