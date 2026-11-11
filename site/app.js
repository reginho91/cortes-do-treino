/* Cortes do Treino
   Tudo roda no próprio aparelho: lê os vídeos, acha o pedaço com movimento,
   monta o Story (Sequência ou 3 telas) e gera o MP4. Nada é enviado para a internet. */
'use strict';
(() => {

// ---------- Medidas e ritmos ----------
const FPS = 30;
const LARG = 1080, ALT = 1920;               // quadro do Story (coordenadas de desenho)
const FAIXA_ALT = 636, FAIXA_VAO = 6;         // 3 telas: 3 x 636 + 2 x 6 = 1920
const ASPECTO = { sequencia: LARG / ALT, telas: LARG / FAIXA_ALT };
const RITMOS = {
  sequencia: { rapido: 2.2, normal: 3, calmo: 4 },  // segundos de cada exercício
  telas: { rapido: 3, normal: 4, calmo: 5 },
};
const TRANSICAO = 0.35;           // troca suave entre exercícios (Sequência)
const ENTRADA = 0.3, SAIDA = 0.45; // clarear no começo e escurecer no fim
const CASCATA = 0.5;              // 3 telas: cada tela troca meio segundo depois da de cima
const ZOOM_MIN = 0.4;
const EXTENSOES = /\.(mp4|mov|m4v|webm|3gp|mkv)$/i;
const CACHE_COMPARTILHADOS = 'cortes-compartilhados';

const estado = {
  clipes: [],
  estilo: 'sequencia',
  ritmo: 'normal',
  resultado: null,   // { arquivo, url, dur }
  render: null,      // { cancelar(motivo) }
};
let proximoId = 1;

const $ = (s, r = document) => r.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
class Cancelado extends Error {}

// ---------- Utilidades ----------
function aviso(texto, ms = 4000) {
  const el = $('#aviso');
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => { el.hidden = true; }, ms);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtSeg(s) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0').replace('.', ',')}`;
}

function esperar(alvo, nome, ms) {
  return new Promise((ok, falha) => {
    let t = 0;
    const limpar = () => { clearTimeout(t); alvo.removeEventListener(nome, bom); alvo.removeEventListener('error', ruim); };
    const bom = () => { limpar(); ok(true); };
    const ruim = () => { limpar(); falha(new Error('erro no vídeo')); };
    alvo.addEventListener(nome, bom);
    alvo.addEventListener('error', ruim);
    if (ms) t = setTimeout(() => { limpar(); ok(false); }, ms);
  });
}

function criarVideo(url) {
  const v = document.createElement('video');
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('muted', '');
  v.preload = 'auto';
  v.src = url;
  $('#deposito').appendChild(v);
  return v;
}

function liberarVideo(v) {
  if (!v) return;
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* nada */ }
  v.remove();
}

async function metadados(v) {
  if (v.readyState >= 1) return true;
  return esperar(v, 'loadedmetadata', 15000);
}

async function irPara(v, t) {
  const alvo = clamp(t, 0, Math.max(0, (v.duration || 0) - 0.04));
  if (Math.abs(v.currentTime - alvo) < 0.002 && v.readyState >= 2) return;
  const p = esperar(v, 'seeked', 5000);
  v.currentTime = alvo;
  await p;
}

// Data e hora pelo nome do arquivo (VID_20261109_054639.mp4 e parecidos)
function lerNome(arquivo) {
  const m = arquivo.name.match(/(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/);
  if (m) {
    const [, a, me, d, h, mi, s] = m;
    return { ordem: new Date(+a, +me - 1, +d, +h, +mi, +s).getTime(), rotulo: `${h}:${mi}`, data: `${d}-${me}-${a}` };
  }
  const base = arquivo.name.replace(/\.[^.]+$/, '');
  return { ordem: arquivo.lastModified || 0, rotulo: base.length > 22 ? base.slice(0, 20) + '…' : base, data: null };
}

// ---------- Telas ----------
function mostrarTela(nome) {
  for (const id of ['telaInicio', 'telaMontar', 'telaGerando', 'telaPronto']) {
    $('#' + id).hidden = id !== 'tela' + nome[0].toUpperCase() + nome.slice(1);
  }
  window.scrollTo(0, 0);
}

// ---------- Entrada dos vídeos ----------
function adicionarArquivos(lista) {
  const novos = Array.from(lista || []).filter(f => (f.type || '').startsWith('video/') || EXTENSOES.test(f.name || ''));
  if (!novos.length) { aviso('Escolha arquivos de vídeo.'); return; }
  const itens = novos.map(f => ({ f, info: lerNome(f) })).sort((a, b) => a.info.ordem - b.info.ordem);
  for (const { f, info } of itens) {
    estado.clipes.push({
      id: proximoId++, arquivo: f, url: URL.createObjectURL(f),
      rotulo: info.rotulo, data: info.data,
      dur: 0, vw: 0, vh: 0, rot: 0,
      amostras: null, auto: {}, inicio: 0, inicioManual: false,
      enq: { sequencia: null, telas: null }, cacheEnq: null,
      analise: 'esperando', progresso: 0, mini: null,
    });
  }
  mostrarTela('montar');
  renderLista();
  filaAnalise();
}

function tirarClipe(c) {
  const i = estado.clipes.indexOf(c);
  if (i < 0) return;
  estado.clipes.splice(i, 1);
  URL.revokeObjectURL(c.url);
  if (!estado.clipes.length) { mostrarTela('inicio'); }
  renderLista();
}

function limparTudo() {
  for (const c of estado.clipes) URL.revokeObjectURL(c.url);
  estado.clipes = [];
  if (estado.resultado) { URL.revokeObjectURL(estado.resultado.url); estado.resultado = null; }
  $('#videoPronto').removeAttribute('src');
  renderLista();
  if ('caches' in window) caches.delete(CACHE_COMPARTILHADOS).catch(() => {});
}

// ---------- Análise: onde está o movimento ----------
let analisando = 0;
function filaAnalise() {
  while (analisando < 2) {
    const c = estado.clipes.find(x => x.analise === 'esperando');
    if (!c) break;
    analisando++;
    analisar(c).finally(() => { analisando--; filaAnalise(); });
  }
  atualizarResumo();
}

async function analisar(c) {
  c.analise = 'analisando';
  c.progresso = 0;
  atualizarEstadoCartao(c);
  const v = criarVideo(c.url);
  try {
    if (!(await metadados(v))) throw new Error('sem metadados');
    if (!v.videoWidth || !isFinite(v.duration) || v.duration <= 0) throw new Error('vídeo inválido');
    c.dur = v.duration; c.vw = v.videoWidth; c.vh = v.videoHeight;
    const lado = 48;
    const aw = c.vw >= c.vh ? lado : Math.max(8, Math.round(lado * c.vw / c.vh));
    const ah = c.vw >= c.vh ? Math.max(8, Math.round(lado * c.vh / c.vw)) : lado;
    const cv = document.createElement('canvas');
    cv.width = aw; cv.height = ah;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    const passo = Math.max(0.33, c.dur / 120);
    const n = Math.max(2, Math.floor((c.dur - 0.05) / passo) + 1);
    const notas = new Float32Array(n);
    const fracs = new Float32Array(n);   // quanto da tela mudou (perto de tudo = câmera mexendo)
    const mapas = new Array(n);
    let anterior = null;
    for (let i = 0; i < n; i++) {
      if (!estado.clipes.includes(c)) throw new Cancelado();
      await irPara(v, i * passo);
      ctx.drawImage(v, 0, 0, aw, ah);
      const px = ctx.getImageData(0, 0, aw, ah).data;
      const cinza = new Uint8Array(aw * ah);
      for (let p = 0, q = 0; p < cinza.length; p++, q += 4) cinza[p] = (px[q] * 77 + px[q + 1] * 150 + px[q + 2] * 29) >> 8;
      const mapa = new Uint8Array(aw * ah);
      if (anterior) {
        let soma = 0, mudou = 0;
        for (let p = 0; p < cinza.length; p++) {
          const d = Math.abs(cinza[p] - anterior[p]);
          if (d > 14) { mapa[p] = d; soma += d; mudou++; }
        }
        notas[i] = soma / cinza.length;
        fracs[i] = mudou / cinza.length;
      }
      mapas[i] = mapa;
      anterior = cinza;
      if (i % 3 === 0 || i === n - 1) { c.progresso = (i + 1) / n; atualizarEstadoCartao(c); }
    }
    notas[0] = notas[1];
    fracs[0] = fracs[1];
    c.amostras = { passo, n, notas, fracs, mapas, aw, ah };
    // miniatura no meio do pedaço escolhido
    const L = janelaAtual();
    await irPara(v, inicioDe(c, L) + Math.min(L, c.dur) / 2);
    const mini = document.createElement('canvas');
    const escala = 200 / Math.max(c.vw, c.vh);
    mini.width = Math.max(1, Math.round(c.vw * escala));
    mini.height = Math.max(1, Math.round(c.vh * escala));
    mini.getContext('2d').drawImage(v, 0, 0, mini.width, mini.height);
    c.mini = mini;
    c.analise = 'pronto';
  } catch (e) {
    if (!(e instanceof Cancelado)) { c.analise = 'erro'; console.warn('Análise falhou:', c.arquivo.name, e); }
  } finally {
    liberarVideo(v);
  }
  if (estado.clipes.includes(c)) renderLista();
}

// Melhor pedaço de L segundos.
// 1) Marca os momentos em que a CÂMERA se mexe (ajeitando ou pegando o celular): quase a tela
//    toda muda de uma vez. Esses momentos, e 1 s antes e depois, ficam de fora.
// 2) Acha a região de ~8 s com movimento constante (picos cortados no percentil 80)
//    e o melhor pedaço dentro dela.
function escolherAutomatico(c, L) {
  const { passo, n, notas, fracs } = c.amostras;
  const dur = c.dur;
  if (dur <= L + 0.05) return 0;
  const ordF = Array.from(fracs).slice(1).sort((a, b) => a - b);
  const limite = Math.max(0.25, 2.5 * (ordF[Math.floor(ordF.length / 2)] || 0));
  const folga = Math.ceil(1 / passo);
  const ruim = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    if (fracs[i] > limite) for (let j = Math.max(0, i - folga); j <= Math.min(n - 1, i + folga); j++) ruim[j] = 1;
  }
  const bons = [];
  for (let i = 1; i < n; i++) if (!ruim[i]) bons.push(notas[i]);
  bons.sort((a, b) => a - b);
  const teto = Math.max(1e-6, bons.length ? bons[Math.floor(0.8 * (bons.length - 1))] : 1);
  const peso = new Float32Array(n);
  for (let i = 1; i < n; i++) peso[i] = ruim[i] ? -10 * teto : Math.min(notas[i], teto);
  const margem = dur > 8 ? 1 : 0;
  let lo = margem, hi = dur - margem;
  if (hi - lo < L) { lo = 0; hi = dur; }
  // o movimento entre a amostra i-1 e i fica no tempo (i - 0,5) x passo
  const soma = (a, len) => {
    let s = 0;
    for (let i = 1; i < n; i++) {
      const t = (i - 0.5) * passo;
      if (t >= a && t <= a + len) s += peso[i];
    }
    return s;
  };
  const W = Math.min(Math.max(8, L), hi - lo);
  let melhorA = lo, melhorS = -1;
  for (let a = lo; a + W <= hi + 1e-6; a += passo / 2) {
    const s = soma(a, W);
    if (s > melhorS + 1e-9) { melhorS = s; melhorA = a; }
  }
  let melhorB = melhorA, melhorSB = -1;
  for (let b = melhorA; b + L <= melhorA + W + 1e-6; b += passo / 2) {
    const s = soma(b, L);
    if (s > melhorSB + 1e-9) { melhorSB = s; melhorB = b; }
  }
  return clamp(melhorB, 0, Math.max(0, dur - L - 0.05));
}

function janelaAtual() { return RITMOS[estado.estilo][estado.ritmo]; }

function inicioDe(c, L) {
  if (!c.amostras) return 0;
  const maxIni = Math.max(0, c.dur - L - 0.05);
  if (c.inicioManual) return clamp(c.inicio, 0, maxIni);
  const k = L.toFixed(2);
  if (c.auto[k] === undefined) c.auto[k] = escolherAutomatico(c, L);
  return clamp(c.auto[k], 0, maxIni);
}

function definirInicio(c, t) {
  const L = janelaAtual();
  c.inicio = clamp(t, 0, Math.max(0, c.dur - L - 0.05));
  c.inicioManual = true;
}

// Onde o movimento aconteceu dentro do pedaço (caixa e centro, de 0 a 1, no quadro original)
function mapaMovimento(c, inicio, L) {
  const { passo, n, mapas, aw, ah } = c.amostras;
  const soma = new Float32Array(aw * ah);
  const i0 = Math.max(1, Math.floor(inicio / passo));
  const i1 = Math.min(n - 1, Math.ceil((inicio + L) / passo));
  for (let i = i0; i <= i1; i++) {
    const m = mapas[i];
    for (let p = 0; p < soma.length; p++) soma[p] += m[p];
  }
  const borrado = new Float32Array(aw * ah);
  let max = 0;
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      let s = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && xx < aw && yy >= 0 && yy < ah) { s += soma[yy * aw + xx]; k++; }
        }
      }
      const val = s / k;
      borrado[y * aw + x] = val;
      if (val > max) max = val;
    }
  }
  if (max < 1) return null;
  // Separa em blocos (pontos vizinhos) e fica com o bloco de mais movimento: a pessoa.
  // Uma luz piscando num canto ou uma TV ao fundo viram blocos pequenos e ficam de fora.
  const lim = max * 0.3;
  const grupo = new Int32Array(aw * ah).fill(-1);
  let melhor = null;
  for (let p0 = 0; p0 < aw * ah; p0++) {
    if (grupo[p0] >= 0 || borrado[p0] < lim) continue;
    const bloco = { x0: aw, y0: ah, x1: -1, y1: -1, sx: 0, sy: 0, sp: 0 };
    const pilha = [p0];
    grupo[p0] = p0;
    while (pilha.length) {
      const p = pilha.pop();
      const x = p % aw, y = (p - x) / aw, val = borrado[p];
      if (x < bloco.x0) bloco.x0 = x; if (x > bloco.x1) bloco.x1 = x;
      if (y < bloco.y0) bloco.y0 = y; if (y > bloco.y1) bloco.y1 = y;
      bloco.sx += (x + 0.5) * val; bloco.sy += (y + 0.5) * val; bloco.sp += val;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= aw || yy < 0 || yy >= ah) continue;
          const q = yy * aw + xx;
          if (grupo[q] < 0 && borrado[q] >= lim) { grupo[q] = p0; pilha.push(q); }
        }
      }
    }
    if (!melhor || bloco.sp > melhor.sp) melhor = bloco;
  }
  if (!melhor) return null;
  const b = melhor;
  return { u0: b.x0 / aw, v0: b.y0 / ah, u1: (b.x1 + 1) / aw, v1: (b.y1 + 1) / ah, cu: b.sx / b.sp / aw, cv: b.sy / b.sp / ah };
}

// ---------- Giro e enquadramento ----------
function dims(c) { return c.rot % 180 ? [c.vh, c.vw] : [c.vw, c.vh]; }

function girarPonto(u, v, rot) {
  if (rot === 90) return [1 - v, u];
  if (rot === 180) return [1 - u, 1 - v];
  if (rot === 270) return [v, 1 - u];
  return [u, v];
}

function baseRecorte(W, H, asp) {
  return W / H > asp ? { w: H * asp, h: H } : { w: W, h: W / asp };
}

function enquadreDe(c, estilo) {
  return c.enq[estilo] || enquadreAuto(c, estilo);
}

function enquadreAuto(c, estilo) {
  const L = RITMOS[estilo][estado.ritmo];
  const ini = inicioDe(c, L);
  const chave = `${estilo}|${L}|${ini.toFixed(2)}|${c.rot}`;
  if (c.cacheEnq && c.cacheEnq.chave === chave) return c.cacheEnq.val;
  let val = { cx: 0.5, cy: 0.5, z: 1 };
  const m = c.amostras ? mapaMovimento(c, ini, L) : null;
  if (m) {
    const [ax, ay] = girarPonto(m.u0, m.v0, c.rot);
    const [bx, by] = girarPonto(m.u1, m.v1, c.rot);
    const [gx, gy] = girarPonto(m.cu, m.cv, c.rot);
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    const [W, H] = dims(c);
    const asp = ASPECTO[estilo];
    const base = baseRecorte(W, H, asp);
    let z = 1;
    let cy = 0.5;
    if (estilo === 'telas') {
      const precisa = Math.max((x1 - x0) * W * 1.15, (y1 - y0) * H * 1.25 * asp);
      z = clamp(precisa / base.w, 0.62, 1);
      cy = clamp(0.5 * ((y0 + y1) / 2) + 0.5 * gy, 0, 1);
    }
    val = { cx: clamp(0.5 * ((x0 + x1) / 2) + 0.5 * gx, 0, 1), cy, z };
  }
  c.cacheEnq = { chave, val };
  return val;
}

// Retângulo do recorte no quadro já girado (em pixels e de 0 a 1)
function retangulo(c, enq, estilo) {
  const [W, H] = dims(c);
  const b = baseRecorte(W, H, ASPECTO[estilo]);
  const w = b.w * enq.z, h = b.h * enq.z;
  const x = clamp(enq.cx * W - w / 2, 0, W - w);
  const y = clamp(enq.cy * H - h / 2, 0, H - h);
  return { x, y, w, h, W, H, nx: x / W, ny: y / H, nw: w / W, nh: h / H };
}

// Desenha a parte r (de 0 a 1, no quadro girado) da fonte dentro do retângulo de destino
function desenharRecorte(ctx, fonte, fw, fh, rot, r, dx, dy, dw, dh) {
  const W = rot % 180 ? fh : fw, H = rot % 180 ? fw : fh;
  const sx = r.nx * W, sy = r.ny * H, sw = r.nw * W, sh = r.nh * H;
  if (!rot) { ctx.drawImage(fonte, sx, sy, sw, sh, dx, dy, dw, dh); return; }
  const kx = dw / sw, ky = dh / sh;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.translate(dx - sx * kx, dy - sy * ky);
  ctx.scale(kx, ky);
  if (rot === 90) { ctx.translate(W, 0); ctx.rotate(Math.PI / 2); }
  else if (rot === 180) { ctx.translate(W, H); ctx.rotate(Math.PI); }
  else { ctx.translate(0, H); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(fonte, 0, 0, fw, fh);
  ctx.restore();
}

// ---------- Lista de vídeos ----------
function textoEstado(c) {
  if (c.analise === 'esperando') return 'Na fila…';
  if (c.analise === 'analisando') return `Procurando o exercício… ${Math.round(c.progresso * 100)}%`;
  if (c.analise === 'erro') return 'Não consegui ler este vídeo. Tire da lista.';
  return '';
}

function renderLista() {
  const ol = $('#listaClipes');
  ol.innerHTML = '';
  const total = estado.clipes.length;
  estado.clipes.forEach((c, i) => {
    const pronto = c.analise === 'pronto';
    const li = document.createElement('li');
    li.className = 'clipe' + (c.analise === 'erro' ? ' erro' : '');
    li.dataset.id = c.id;
    li.innerHTML = `
      <button type="button" class="clipe-mini" data-acao="ajustar" aria-label="Ajustar o vídeo ${i + 1}" ${pronto ? '' : 'disabled'}>
        <canvas width="128" height="228"></canvas><span class="clipe-num">${i + 1}</span>
      </button>
      <div class="clipe-corpo">
        <div class="clipe-titulo"><span>${esc(c.rotulo)}</span><span>${c.dur ? fmtDur(c.dur) : ''}</span></div>
        ${pronto
          ? '<canvas class="linha-movimento" role="img" aria-label="Movimento ao longo do vídeo; o pedaço laranja entra no Story. Toque para mudar."></canvas>'
          : `<div class="clipe-estado">${esc(textoEstado(c))}</div>`}
        <div class="clipe-acoes">
          <button type="button" class="btn-icone" data-acao="subir" aria-label="Subir" ${i === 0 ? 'disabled' : ''}><svg><use href="#i-cima"/></svg></button>
          <button type="button" class="btn-icone" data-acao="descer" aria-label="Descer" ${i === total - 1 ? 'disabled' : ''}><svg><use href="#i-baixo"/></svg></button>
          <button type="button" class="btn-icone" data-acao="girar" aria-label="Girar" ${pronto ? '' : 'disabled'}><svg><use href="#i-girar"/></svg></button>
          <button type="button" class="btn-icone" data-acao="ajustar" aria-label="Ajustar" ${pronto ? '' : 'disabled'}><svg><use href="#i-ajustar"/></svg></button>
          <button type="button" class="btn-icone perigo empurra" data-acao="tirar" aria-label="Tirar da montagem"><svg><use href="#i-lixo"/></svg></button>
        </div>
      </div>`;
    ol.appendChild(li);
  });
  requestAnimationFrame(() => estado.clipes.forEach(desenharCartao));
  atualizarResumo();
}

function cartaoDe(c) { return document.querySelector(`li.clipe[data-id="${c.id}"]`); }

function atualizarEstadoCartao(c) {
  const el = cartaoDe(c)?.querySelector('.clipe-estado');
  if (el) el.textContent = textoEstado(c);
}

function desenharCartao(c) {
  const li = cartaoDe(c);
  if (!li) return;
  const mini = li.querySelector('.clipe-mini canvas');
  if (mini) {
    const ctx = mini.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, mini.width, mini.height);
    if (c.mini) {
      const r = retangulo(c, enquadreDe(c, 'sequencia'), 'sequencia');
      desenharRecorte(ctx, c.mini, c.mini.width, c.mini.height, c.rot, r, 0, 0, mini.width, mini.height);
    }
  }
  const linha = li.querySelector('canvas.linha-movimento');
  if (linha) desenharLinha(linha, c);
}

function desenharLinha(cv, c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (!w || !h) return;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!c.amostras) return;
  const { n, notas, passo } = c.amostras;
  const L = janelaAtual();
  const ini = inicioDe(c, L);
  const fim = Math.min(c.dur, ini + L);
  let max = 0;
  for (const x of notas) if (x > max) max = x;
  max = max || 1;
  const x0 = ini / c.dur * w, x1 = fim / c.dur * w;
  ctx.fillStyle = 'rgba(255,117,0,.16)';
  ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
  const bw = w / n;
  for (let i = 0; i < n; i++) {
    const t = i * passo;
    const bh = Math.max(2 * dpr, Math.sqrt(notas[i] / max) * (h - 8 * dpr));
    ctx.fillStyle = t >= ini - passo / 2 && t <= fim + passo / 2 ? '#FF7500' : '#434b58';
    ctx.fillRect(i * bw + bw * 0.15, h - bh - 4 * dpr, Math.max(1, bw * 0.7), bh);
  }
  ctx.strokeStyle = '#FF7500';
  ctx.lineWidth = 2 * dpr;
  ctx.strokeRect(x0 + dpr, dpr, Math.max(2 * dpr, x1 - x0 - 2 * dpr), h - 2 * dpr);
}

function tempoNaLinha(cv, c, clientX) {
  const r = cv.getBoundingClientRect();
  return clamp((clientX - r.left) / r.width, 0, 1) * c.dur;
}

function atualizarResumo() {
  const prontos = estado.clipes.filter(c => c.analise === 'pronto').length;
  const pendentes = estado.clipes.filter(c => c.analise === 'esperando' || c.analise === 'analisando').length;
  const el = $('#resumoMontagem');
  const btn = $('#btnGerar');
  el.classList.remove('alerta');
  let ok = prontos > 0;
  if (pendentes) {
    el.textContent = `Procurando o exercício nos vídeos… ${pendentes === 1 ? 'falta 1' : `faltam ${pendentes}`}`;
    ok = false;
  } else if (!prontos) {
    el.textContent = 'Escolha pelo menos um vídeo.';
  } else if (estado.estilo === 'telas' && prontos < 3) {
    el.textContent = 'Para 3 telas, escolha pelo menos 3 vídeos.';
    el.classList.add('alerta');
    ok = false;
  } else {
    const d = duracaoTotal(prontos);
    el.textContent = `${prontos} ${prontos === 1 ? 'vídeo' : 'vídeos'} · Story de ${Math.round(d)} s`
      + (d > 60 ? ' (o Instagram divide em partes de 60 s)' : '');
    if (d > 60) el.classList.add('alerta');
  }
  btn.disabled = !ok;
}

function duracaoTotal(n) {
  if (estado.estilo === 'telas') return Math.ceil(n / 3) * RITMOS.telas[estado.ritmo];
  const L = RITMOS.sequencia[estado.ritmo];
  return n * L - (n - 1) * (n > 1 ? TRANSICAO : 0);
}

// ---------- Plano do vídeo final ----------
function montarPlano() {
  const clipes = estado.clipes.filter(c => c.analise === 'pronto');
  return estado.estilo === 'telas' ? planoTelas(clipes) : planoSequencia(clipes);
}

function planoSequencia(clipes) {
  const L = RITMOS.sequencia[estado.ritmo];
  const X = clipes.length > 1 ? TRANSICAO : 0;
  const segs = clipes.map((c, k) => ({
    c, t0: k * (L - X), t1: k * (L - X) + L,
    src: inicioDe(c, L),
    r: retangulo(c, enquadreDe(c, 'sequencia'), 'sequencia'),
    alvo: [0, 0, LARG, ALT],
    suave: k > 0 ? X : 0,
  }));
  return { total: clipes.length * L - (clipes.length - 1) * X, segs, fundo: '#000' };
}

function planoTelas(clipes) {
  const D = RITMOS.telas[estado.ritmo];
  const faixas = [[], [], []];
  clipes.forEach((c, i) => faixas[i % 3].push(c));
  const total = Math.max(...faixas.map(f => f.length)) * D;
  const segs = [];
  faixas.forEach((f, b) => {
    const pontos = [0];
    for (let j = 1; j < f.length; j++) pontos.push(Math.min(total - 0.5, total * j / f.length + b * CASCATA));
    pontos.push(total);
    f.forEach((c, j) => {
      const len = pontos[j + 1] - pontos[j];
      segs.push({
        c, t0: pontos[j], t1: pontos[j + 1],
        src: clamp(inicioDe(c, D), 0, Math.max(0, c.dur - len - 0.05)),
        r: retangulo(c, enquadreDe(c, 'telas'), 'telas'),
        alvo: [0, b * (FAIXA_ALT + FAIXA_VAO), LARG, FAIXA_ALT],
        suave: 0,
      });
    });
  });
  return { total, segs, fundo: '#fff' };
}

function desenharQuadro(ctx, plano, t) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = plano.fundo;
  ctx.fillRect(0, 0, LARG, ALT);
  for (const s of plano.segs) {
    const ultimo = s.t1 >= plano.total - 1e-6;
    if (t < s.t0 || (t >= s.t1 && !ultimo)) continue;
    const v = s.v;
    if (!v || v.readyState < 2) continue;
    ctx.globalAlpha = s.suave && t < s.t0 + s.suave ? clamp((t - s.t0) / s.suave, 0, 1) : 1;
    desenharRecorte(ctx, v, v.videoWidth, v.videoHeight, s.c.rot, s.r, ...s.alvo);
  }
  ctx.globalAlpha = 1;
  let escuro = 0;
  if (t < ENTRADA) escuro = 1 - t / ENTRADA;
  else if (t > plano.total - SAIDA) escuro = (t - (plano.total - SAIDA)) / SAIDA;
  if (escuro > 0) {
    ctx.fillStyle = `rgba(0,0,0,${clamp(escuro, 0, 1).toFixed(3)})`;
    ctx.fillRect(0, 0, LARG, ALT);
  }
}

// ---------- Gravação do MP4 ----------
async function configuracaoSuportada(w, h) {
  const codecs = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.420028'];
  for (const hw of ['prefer-hardware', 'no-preference']) {
    for (const codec of codecs) {
      const cfg = {
        codec, width: w, height: h,
        bitrate: w >= 1080 ? 8_000_000 : 5_000_000,
        framerate: FPS, hardwareAcceleration: hw, avc: { format: 'avc' },
      };
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r.supported) return cfg;
      } catch (e) { /* tenta o próximo */ }
    }
  }
  return null;
}

async function criarGravador(cv) {
  if ('VideoEncoder' in window && 'VideoFrame' in window && window.Mp4Muxer) {
    for (const [w, h] of [[1080, 1920], [720, 1280]]) {
      const cfg = await configuracaoSuportada(w, h);
      if (cfg) {
        cv.width = w; cv.height = h;
        return gravadorWebCodecs(cv, cfg);
      }
    }
  }
  cv.width = LARG; cv.height = ALT;
  return gravadorMediaRecorder(cv);
}

function gravadorWebCodecs(cv, cfg) {
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: cfg.width, height: cfg.height, frameRate: FPS },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let erro = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { erro = e; },
  });
  enc.configure(cfg);
  let ultimaChave = -Infinity;
  return {
    ext: 'mp4',
    modo: `webcodecs ${cfg.codec} ${cfg.width}x${cfg.height} ${cfg.hardwareAcceleration}`,
    quadro(k) {
      if (erro) throw erro;
      if (enc.encodeQueueSize > 24) return;  // aparelho atrasado: pula o quadro em vez de acumular memória
      const f = new VideoFrame(cv, { timestamp: Math.round(k * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      const chave = k - ultimaChave >= FPS * 2;
      if (chave) ultimaChave = k;
      try { enc.encode(f, { keyFrame: chave }); } finally { f.close(); }
    },
    async terminar() {
      await enc.flush();
      if (erro) throw erro;
      enc.close();
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    },
    cancelar() { try { enc.close(); } catch (e) { /* nada */ } },
  };
}

function gravadorMediaRecorder(cv) {
  if (!('MediaRecorder' in window) || !cv.captureStream) return null;
  const tipos = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const tipo = tipos.find(t => MediaRecorder.isTypeSupported(t));
  if (!tipo) return null;
  const stream = cv.captureStream(FPS);
  const rec = new MediaRecorder(stream, { mimeType: tipo, videoBitsPerSecond: 8_000_000 });
  const partes = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) partes.push(e.data); };
  return {
    ext: tipo.startsWith('video/mp4') ? 'mp4' : 'webm',
    modo: `mediarecorder ${tipo}`,
    quadro() { if (rec.state === 'inactive') rec.start(500); },
    terminar: () => new Promise(ok => {
      rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); ok(new Blob(partes, { type: tipo.split(';')[0] })); };
      rec.stop();
    }),
    cancelar() { try { rec.stop(); } catch (e) { /* nada */ } stream.getTracks().forEach(t => t.stop()); },
  };
}

// Relógio de ~80 batidas por segundo. Usa um "trabalhador" separado porque o relógio da tela
// (requestAnimationFrame) fica lento quando a janela não está na frente.
function criarRelogio(fn) {
  let parado = false, trabalhador = null, raf = 0;
  try {
    const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 12);'], { type: 'text/javascript' }));
    trabalhador = new Worker(url);
    URL.revokeObjectURL(url);
    trabalhador.onmessage = () => { if (!parado) fn(); };
  } catch (e) { trabalhador = null; }
  if (!trabalhador) {
    const volta = () => { if (parado) return; fn(); raf = requestAnimationFrame(volta); };
    raf = requestAnimationFrame(volta);
  }
  return {
    parar() {
      parado = true;
      if (trabalhador) trabalhador.terminate();
      cancelAnimationFrame(raf);
    },
  };
}

// ---------- Gerar (em tempo real: os vídeos tocam e cada quadro é gravado) ----------
async function gerar() {
  const plano = montarPlano();
  if (!plano.segs.length) return;
  mostrarTela('gerando');
  const cv = $('#telaRender');
  const txt = $('#textoProgresso'), barra = $('#barraProgresso');
  txt.textContent = 'Preparando…';
  barra.style.width = '0%';
  let cancelado = null;
  let trava = null;
  let gravador = null;
  const segs = plano.segs.map(s => ({ ...s, v: null, fase: 'novo', pronto: null }));
  plano.segs = segs;
  estado.render = { cancelar: (motivo) => { cancelado = motivo || 'usuario'; } };
  try {
    gravador = await criarGravador(cv);
    if (!gravador) throw new Error('Este navegador não consegue gerar o vídeo. Abra no Chrome atualizado.');
    const escala = cv.width / LARG;
    const ctx = cv.getContext('2d', { alpha: false });
    ctx.setTransform(escala, 0, 0, escala, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, LARG, ALT);
    try { trava = await navigator.wakeLock?.request('screen'); } catch (e) { /* sem trava de tela */ }

    const ANTECIPA = 2.5, PRE = 0.25;
    const preparar = (s) => {
      s.fase = 'preparando';
      s.v = criarVideo(s.c.url);
      const v = s.v;
      s.pronto = (async () => { await metadados(v); await irPara(v, Math.max(0, s.src - PRE)); })()
        .catch(() => {})
        .then(() => { if (s.fase === 'preparando') s.fase = 'pronto'; });
    };
    segs.filter(s => s.t0 < ANTECIPA).forEach(preparar);
    await Promise.all(segs.filter(s => s.pronto).map(s => s.pronto));
    if (cancelado) throw new Cancelado(cancelado);

    const totalQuadros = Math.max(1, Math.round(plano.total * FPS));
    let k = 0;
    let relogio0 = null;
    let relogio = null;
    await new Promise((ok, falha) => {
      const tique = () => {
        try {
          if (cancelado) { relogio.parar(); falha(new Cancelado(cancelado)); return; }
          const agora = performance.now();
          if (relogio0 === null) relogio0 = agora + PRE * 1000;
          const t = (agora - relogio0) / 1000;
          for (const s of segs) {
            if (s.fase === 'novo' && t >= s.t0 - ANTECIPA) preparar(s);
            if (s.fase === 'pronto' && t >= s.t0 - PRE) { s.fase = 'tocando'; s.v.play().catch(() => {}); }
            if (s.v && t > s.t1 + 0.3) { liberarVideo(s.v); s.v = null; s.fase = 'fim'; }
          }
          if (t >= 0) {
            const alvo = Math.min(totalQuadros - 1, Math.floor(t * FPS));
            if (alvo >= k) {
              desenharQuadro(ctx, plano, alvo / FPS);
              gravador.quadro(alvo);
              k = alvo + 1;
              const pct = Math.round(k / totalQuadros * 100);
              barra.style.width = pct + '%';
              txt.textContent = `Gerando… ${pct}%`;
            }
          }
          if (k >= totalQuadros) { relogio.parar(); ok(); }
        } catch (e) { relogio.parar(); falha(e); }
      };
      relogio = criarRelogio(tique);
    });
    txt.textContent = 'Finalizando…';
    const blob = await gravador.terminar();
    gravador = null;
    const primeiro = estado.clipes.find(c => c.analise === 'pronto' && c.data);
    const data = primeiro ? primeiro.data : new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
    const arquivo = new File([blob], `treino-${data}.${blob.type === 'video/mp4' ? 'mp4' : 'webm'}`, { type: blob.type, lastModified: Date.now() });
    mostrarResultado(arquivo, plano.total);
  } catch (e) {
    if (gravador) gravador.cancelar();
    mostrarTela('montar');
    if (e instanceof Cancelado) {
      if (e.message === 'saiu') aviso('A geração parou porque a tela saiu do app. Toque em Gerar vídeo de novo e deixe a tela aberta.', 7000);
    } else {
      console.error(e);
      aviso(e && e.message ? e.message : 'Não deu certo. Tente de novo.', 7000);
    }
  } finally {
    for (const s of segs) if (s.v) { liberarVideo(s.v); s.v = null; }
    try { await trava?.release(); } catch (e) { /* nada */ }
    estado.render = null;
  }
}

function mostrarResultado(arquivo, dur) {
  if (estado.resultado) URL.revokeObjectURL(estado.resultado.url);
  const url = URL.createObjectURL(arquivo);
  estado.resultado = { arquivo, url, dur };
  window.__ultimoResultado = arquivo;
  const video = $('#videoPronto');
  video.src = url;
  video.play().catch(() => {});
  const salvar = $('#btnSalvar');
  salvar.href = url;
  salvar.download = arquivo.name;
  const mb = arquivo.size / 1048576;
  $('#infoPronto').textContent = `${Math.round(dur)} s · ${mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)} MB`;
  let pode = false;
  try { pode = !!(navigator.canShare && navigator.canShare({ files: [arquivo] })); } catch (e) { pode = false; }
  $('#btnCompartilhar').hidden = !pode;
  salvar.classList.toggle('btn-primario', !pode);
  salvar.classList.toggle('btn-secundario', pode);
  mostrarTela('pronto');
}

// ---------- Ajuste de um vídeo ----------
const aj = { c: null, v: null, raf: 0, arrasto: null, arrastoLinha: false };

async function abrirAjuste(c) {
  if (c.analise !== 'pronto') return;
  fecharAjuste();
  aj.c = c;
  const modal = $('#modalAjuste');
  const cv = $('#canvasPrevia');
  $('#tituloAjuste').textContent = `Ajustar · ${c.rotulo}`;
  if (estado.estilo === 'telas') { cv.width = 720; cv.height = Math.round(720 / ASPECTO.telas); cv.className = 'faixa'; }
  else { cv.width = 540; cv.height = 960; cv.className = 'retrato'; }
  if (!modal.open) modal.showModal();
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const linha = $('#linhaAjuste');
  requestAnimationFrame(() => desenharLinha(linha, c));
  const v = criarVideo(c.url);
  aj.v = v;
  await metadados(v);
  if (aj.c !== c) return;
  await irPara(v, inicioDe(c, janelaAtual()));
  if (aj.c !== c) return;
  v.play().catch(() => {});
  const passo = () => {
    if (aj.c !== c) return;
    const L = janelaAtual();
    const ini = inicioDe(c, L);
    if (!v.seeking && (v.ended || v.currentTime > ini + Math.min(L, c.dur) || v.currentTime < ini - 0.4)) {
      v.currentTime = ini;
      if (v.paused) v.play().catch(() => {});
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (v.readyState >= 2) {
      desenharRecorte(ctx, v, v.videoWidth, v.videoHeight, c.rot, retangulo(c, enquadreDe(c, estado.estilo), estado.estilo), 0, 0, cv.width, cv.height);
    }
    $('#tempoAjuste').textContent = `começa em ${fmtSeg(ini)}`;
    aj.raf = requestAnimationFrame(passo);
  };
  aj.raf = requestAnimationFrame(passo);
}

function fecharAjuste() {
  const tinha = !!aj.c;
  cancelAnimationFrame(aj.raf);
  liberarVideo(aj.v);
  aj.v = null;
  aj.c = null;
  aj.arrasto = null;
  const modal = $('#modalAjuste');
  if (modal.open) modal.close();
  if (tinha) renderLista();
}

function enquadreEditavel(c) {
  const estilo = estado.estilo;
  const atual = enquadreDe(c, estilo);
  const r = retangulo(c, atual, estilo);
  return { estilo, r, enq: { cx: r.nx + r.nw / 2, cy: r.ny + r.nh / 2, z: atual.z } };
}

function ligarAjuste() {
  const cv = $('#canvasPrevia');
  cv.addEventListener('pointerdown', ev => {
    if (!aj.c) return;
    cv.setPointerCapture(ev.pointerId);
    aj.arrasto = { x: ev.clientX, y: ev.clientY };
  });
  cv.addEventListener('pointermove', ev => {
    if (!aj.arrasto || !aj.c) return;
    const { estilo, r, enq } = enquadreEditavel(aj.c);
    const caixa = cv.getBoundingClientRect();
    const dx = (ev.clientX - aj.arrasto.x) / caixa.width * r.nw;
    const dy = (ev.clientY - aj.arrasto.y) / caixa.height * r.nh;
    aj.arrasto = { x: ev.clientX, y: ev.clientY };
    enq.cx = clamp(enq.cx - dx, r.nw / 2, 1 - r.nw / 2);
    enq.cy = clamp(enq.cy - dy, r.nh / 2, 1 - r.nh / 2);
    aj.c.enq[estilo] = enq;
  });
  const soltar = () => { aj.arrasto = null; };
  cv.addEventListener('pointerup', soltar);
  cv.addEventListener('pointercancel', soltar);

  const linha = $('#linhaAjuste');
  const moverLinha = ev => {
    const c = aj.c;
    if (!c) return;
    definirInicio(c, tempoNaLinha(linha, c, ev.clientX) - janelaAtual() / 2);
    desenharLinha(linha, c);
  };
  linha.addEventListener('pointerdown', ev => { if (!aj.c) return; linha.setPointerCapture(ev.pointerId); aj.arrastoLinha = true; moverLinha(ev); });
  linha.addEventListener('pointermove', ev => { if (aj.arrastoLinha) moverLinha(ev); });
  const soltarLinha = () => { aj.arrastoLinha = false; };
  linha.addEventListener('pointerup', soltarLinha);
  linha.addEventListener('pointercancel', soltarLinha);

  $('#modalAjuste').addEventListener('click', ev => {
    const c = aj.c;
    if (!c) return;
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.mover) {
      definirInicio(c, inicioDe(c, janelaAtual()) + Number(b.dataset.mover));
      desenharLinha(linha, c);
    } else if (b.dataset.zoom) {
      const { estilo, enq } = enquadreEditavel(c);
      enq.z = clamp(enq.z * (Number(b.dataset.zoom) > 0 ? 0.85 : 1 / 0.85), ZOOM_MIN, 1);
      c.enq[estilo] = enq;
    } else if (b.id === 'btnGirar') {
      c.rot = (c.rot + 90) % 360;
      c.enq = { sequencia: null, telas: null };
    } else if (b.id === 'btnAutomatico') {
      c.inicioManual = false;
      c.enq = { sequencia: null, telas: null };
      desenharLinha(linha, c);
      aviso('Voltou para o automático.', 2000);
    } else if (b.id === 'btnOkAjuste' || b.id === 'btnFecharAjuste' || b.closest('#btnFecharAjuste')) {
      fecharAjuste();
    }
  });
  $('#modalAjuste').addEventListener('close', () => { if (aj.c) fecharAjuste(); });
}

// ---------- Vídeos que chegam pelo "Compartilhar" da galeria ----------
async function pegarCompartilhados() {
  const p = new URLSearchParams(location.search);
  if (!p.has('compartilhado')) return;
  history.replaceState(null, '', location.pathname);
  if (p.get('compartilhado') === 'erro' || !('caches' in window)) {
    aviso('Não consegui receber os vídeos. Escolha pelo botão.');
    return;
  }
  try {
    const cache = await caches.open(CACHE_COMPARTILHADOS);
    const arquivos = [];
    for (const req of await cache.keys()) {
      const r = await cache.match(req);
      if (!r) continue;
      const b = await r.blob();
      arquivos.push(new File([b], decodeURIComponent(r.headers.get('X-Nome') || 'video.mp4'), {
        type: b.type || 'video/mp4', lastModified: Number(r.headers.get('X-Data')) || Date.now(),
      }));
    }
    if (arquivos.length) adicionarArquivos(arquivos);
  } catch (e) {
    aviso('Não consegui receber os vídeos. Escolha pelo botão.');
  }
}

// ---------- Ligações da tela ----------
function ligar() {
  const entrada = $('#entradaArquivos');
  entrada.addEventListener('change', () => { adicionarArquivos(entrada.files); entrada.value = ''; });
  const mais = $('#entradaMais');
  mais.addEventListener('change', () => { adicionarArquivos(mais.files); mais.value = ''; });

  // arrastar e soltar (computador)
  const zona = $('#zonaSoltar');
  let contador = 0;
  document.addEventListener('dragenter', ev => { if (ev.dataTransfer?.types?.includes('Files')) { contador++; zona.classList.add('arrastando'); } });
  document.addEventListener('dragleave', () => { contador = Math.max(0, contador - 1); if (!contador) zona.classList.remove('arrastando'); });
  document.addEventListener('dragover', ev => { if (ev.dataTransfer?.types?.includes('Files')) ev.preventDefault(); });
  document.addEventListener('drop', ev => {
    if (!ev.dataTransfer?.files?.length) return;
    ev.preventDefault();
    contador = 0;
    zona.classList.remove('arrastando');
    if (estado.render) return;
    adicionarArquivos(ev.dataTransfer.files);
  });

  // estilo e ritmo
  const escolher = (grupo, chave, valor) => {
    for (const b of grupo.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset[chave] === valor));
  };
  $('#escolhaEstilo').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-estilo]');
    if (!b) return;
    estado.estilo = b.dataset.estilo;
    escolher($('#escolhaEstilo'), 'estilo', estado.estilo);
    renderLista();
  });
  $('#escolhaRitmo').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-ritmo]');
    if (!b) return;
    estado.ritmo = b.dataset.ritmo;
    escolher($('#escolhaRitmo'), 'ritmo', estado.ritmo);
    renderLista();
  });

  // ações nos cartões
  $('#listaClipes').addEventListener('click', ev => {
    const li = ev.target.closest('li.clipe');
    if (!li) return;
    const c = estado.clipes.find(x => x.id === Number(li.dataset.id));
    if (!c) return;
    const linha = ev.target.closest('canvas.linha-movimento');
    if (linha) {
      definirInicio(c, tempoNaLinha(linha, c, ev.clientX) - janelaAtual() / 2);
      desenharLinha(linha, c);
      return;
    }
    const b = ev.target.closest('[data-acao]');
    if (!b || b.disabled) return;
    const i = estado.clipes.indexOf(c);
    const lista = estado.clipes;
    switch (b.dataset.acao) {
      case 'subir': if (i > 0) { [lista[i - 1], lista[i]] = [lista[i], lista[i - 1]]; renderLista(); } break;
      case 'descer': if (i < lista.length - 1) { [lista[i + 1], lista[i]] = [lista[i], lista[i + 1]]; renderLista(); } break;
      case 'girar': c.rot = (c.rot + 90) % 360; c.enq = { sequencia: null, telas: null }; desenharCartao(c); break;
      case 'ajustar': abrirAjuste(c); break;
      case 'tirar': tirarClipe(c); break;
    }
  });

  $('#btnGerar').addEventListener('click', () => { if (!estado.render) gerar(); });
  $('#btnCancelar').addEventListener('click', () => estado.render?.cancelar('usuario'));
  $('#btnVoltarAjustar').addEventListener('click', () => { $('#videoPronto').pause(); mostrarTela('montar'); renderLista(); });
  $('#btnNovo').addEventListener('click', () => { limparTudo(); mostrarTela('inicio'); });
  $('#btnCompartilhar').addEventListener('click', async () => {
    const r = estado.resultado;
    if (!r) return;
    try {
      await navigator.share({ files: [r.arquivo] });
    } catch (e) {
      if (e.name !== 'AbortError') aviso('Não deu para mandar direto. Toque em "Salvar no aparelho" e poste pelo Instagram.', 7000);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && estado.render) estado.render.cancelar('saiu');
  });

  ligarAjuste();

  // instalar como app
  let pedido = null;
  window.addEventListener('beforeinstallprompt', ev => { ev.preventDefault(); pedido = ev; $('#btnInstalar').hidden = false; });
  $('#btnInstalar').addEventListener('click', async () => {
    if (!pedido) return;
    pedido.prompt();
    try { await pedido.userChoice; } catch (e) { /* nada */ }
    pedido = null;
    $('#btnInstalar').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('#btnInstalar').hidden = true; });
  if (window.matchMedia('(display-mode: standalone)').matches) $('#dicaInstalar').hidden = true;

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// Ganchos para teste no computador
window.__cortes = {
  estado,
  adicionarArquivos,
  async carregar(urls) {
    const arquivos = [];
    for (const u of urls) {
      const r = await fetch(u);
      const b = await r.blob();
      arquivos.push(new File([b], decodeURIComponent(u.split('/').pop()), { type: b.type || 'video/mp4' }));
    }
    adicionarArquivos(arquivos);
  },
};

ligar();
pegarCompartilhados();
})();
