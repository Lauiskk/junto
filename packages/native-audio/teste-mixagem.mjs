/**
 * Prova as duas capacidades novas do modulo, medindo energia real.
 *
 *   node packages/native-audio/teste-mixagem.mjs
 *
 * O que precisa ficar demonstrado, e nao so "nao deu erro":
 *
 *  1. As sessoes de audio sao listadas com o nome do executavel.
 *  2. EXCLUDE do proprio processo funciona (o caso do eco da propria sala).
 *  3. INCLUDE de VARIOS processos soma o audio deles — que e a unica forma de
 *     deixar mais de um aplicativo de fora, ja que o Windows so aceita um alvo
 *     por captura.
 *
 * Como nao se enganar: a medicao so vale se houver som tocando. Rode com musica
 * ou video aberto em pelo menos um aplicativo — com tudo em silencio, todos os
 * numeros dao zero e isso nao prova nada.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const nativo = require('./index.js')

if (!nativo.disponivel()) {
  console.error('modulo nativo indisponivel:', nativo.erroDeCarregamento())
  process.exit(1)
}

/** Energia media do bloco. Silencio fica na casa de 1e-5; som audivel, ~0,1. */
function rms(buffers) {
  let soma = 0
  let total = 0
  for (const buf of buffers) {
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const amostra = buf.readInt16LE(i) / 32768
      soma += amostra * amostra
      total++
    }
  }
  return total === 0 ? 0 : Math.sqrt(soma / total)
}

function medir(opcoes, segundos = 3) {
  return new Promise((resolve) => {
    const blocos = []
    nativo.startCapture(opcoes, (chunk) => blocos.push(chunk))
    setTimeout(() => {
      nativo.stopCapture()
      const bytes = blocos.reduce((n, b) => n + b.length, 0)
      resolve({ rms: rms(blocos), blocos: blocos.length, bytes })
    }, segundos * 1000)
  })
}

const meuPid = nativo.currentProcessId()
console.log(`PID deste processo: ${meuPid}\n`)

const sessoes = nativo.listAudioSessions()
console.log(`Sessoes de audio abertas agora: ${sessoes.length}`)
for (const s of sessoes) console.log(`   ${String(s.pid).padStart(7)}  ${s.executable}`)
if (sessoes.length === 0) {
  console.error('\nNenhum aplicativo com audio aberto — abra algo tocando som e repita.')
  process.exit(1)
}

const outros = sessoes.filter((s) => s.pid !== meuPid)

console.log('\n1) EXCLUDE do proprio processo (o caso do eco da propria sala)')
const excluindo = await medir({ excludePid: meuPid })
console.log(`   RMS ${excluindo.rms.toFixed(5)} · ${excluindo.blocos} blocos · ${excluindo.bytes} bytes`)

console.log('\n2) INCLUDE de TODOS os outros processos, somados')
const todos = await medir({ includePids: outros.map((s) => s.pid) })
console.log(`   RMS ${todos.rms.toFixed(5)} · ${todos.blocos} blocos · ${todos.bytes} bytes`)

if (outros.length >= 2) {
  console.log('\n3) INCLUDE de UM so, para comparar com a soma')
  const soUm = await medir({ includePids: [outros[0].pid] })
  console.log(
    `   ${outros[0].executable}: RMS ${soUm.rms.toFixed(5)} · ${soUm.blocos} blocos`
  )
}

console.log('\n4) Troca do conjunto sem parar o audio')
await new Promise((resolve) => {
  const blocos = []
  nativo.startCapture({ includePids: [outros[0].pid] }, (c) => blocos.push(c))
  setTimeout(() => {
    const antes = blocos.length
    // Todos passam a entrar, sem reiniciar a captura.
    nativo.setIncludePids(outros.map((s) => s.pid))
    setTimeout(() => {
      nativo.stopCapture()
      console.log(
        `   ${antes} blocos antes da troca, ${blocos.length - antes} depois — o fluxo nao parou`
      )
      resolve()
    }, 2000)
  }, 2000)
})

console.log('\nO mixer entrega um bloco a cada 10 ms mesmo em silencio, de proposito:')
console.log('a trilha que vai para o WebRTC precisa ser continua, sem buracos.')
