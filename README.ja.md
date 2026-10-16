# FrameEase

[![jsDelivr](https://data.jsdelivr.com/v1/package/npm/frame-ease/badge)](https://www.jsdelivr.com/package/npm/frame-ease)
[![license](https://img.shields.io/npm/l/frame-ease)](LICENSE)

![FrameEase の GUI](https://cdn.jsdelivr.net/npm/frame-ease@0.1.1/docs/frame-ease.gif)

[English](README.md) | [About](#about) | [Why FrameEase?](#why-frameease) | [Getting started](#getting-started) | [API](#api) | [Options](#options) | [Limitations](#limitations)

## About

クリエイティブコーディングのためのイージングライブラリ。
`frameCount` を渡すと、その瞬間の値が返ってくる。ループも往復も待ち時間も、まとめて計算済み。

- [p5.js Web Editor](https://editor.p5js.org/yuta.aoki31/sketches/coVE5pLmj)

## Why FrameEase?

### ⏱ frameCount だけで動く

時間の単位はフレーム数。トゥイーンを作ったり、開始・停止を管理したりは不要。
同じフレームを渡せば、いつも同じ値。書き出しでも動きがずれない。

### 🎛 見ながら決める

GUI で曲線の点を動かすと、スケッチの動きがその場で変わる。
決まったらコピーして sketch.js に貼るだけ。

### 🪶 公開するときは軽く

GUI なしの `frame-ease.core.min.js` に差し替えれば、計算部分だけ。
貼った値はそのまま使える。

## Getting started

### Installation

```html
<script src="https://cdn.jsdelivr.net/npm/frame-ease@0.1.1/frame-ease.min.js"></script>
```

### Usage

```js
// ---- frame-ease state ----
FrameEase.importState({
  move: { duration: 60, loopDelay: 30, stagger: 6, loop: true, alternate: true },
});
// ---- frame-ease state end ----

const N = 8; // 円の数
let move;

function setup() {
  createCanvas(600, 400);
  move = FrameEase('move');
  FrameEase.gui();
}

function draw() {
  background(20);
  noStroke();
  fill(240);
  for (let i = 0; i < N; i++) {
    const x = lerp(60, width - 60, move(frameCount - 1, { index: i }));
    const y = map(i, 0, N - 1, 60, height - 60);
    circle(x, y, 24);
  }
}
```

E キーで GUI の表示・非表示。点をダブルクリックで追加、ドラッグで移動。

これだけ 🎉

### GUI の操作

#### 表示・非表示

E キーで切り替える。ポインタの位置に関係なく効く。Shift を押しているときと、入力欄に文字を打っている間は効かない。
`FrameEase.gui({ key: 'g' })` で別のキーにできる。
最小化しているときに効くキーは、これだけ。

#### 曲線

| 操作 | 動き |
|---|---|
| グラフの空いている所をダブルクリック | その位置に点を足す |
| 点をドラッグ | 点を動かす。Shift で縦か横だけ。始まりの点は動かせず、終わりの点は縦だけ |
| 点を右クリック | 点を消す(両端の点は消せない) |
| ハンドルをドラッグ | 傾きを変える。Alt で片側だけ |
| ハンドルをダブルクリック | 傾きを自動に戻す |

#### 値

| 操作 | 動き |
|---|---|
| 帯の区間を横にドラッグ | 値を変える。Shift で 10 ずつ |
| 数値をクリック | 入力する。↑↓ で 1 ずつ、Shift で 10 ずつ。Enter で決定、Esc で入力を取り消し |

#### キー(ポインタがパネルの上にあるとき)

| キー | 動き |
|---|---|
| 1〜9 | イージングを切り替える |
| Delete / Backspace | 選んでいる点を消す(両端の点は消せない) |
| ← → ↑ ↓ | 選んでいる点を 0.01 動かす。Shift で 0.1。終わりの点は ↑↓ だけ |
| Esc | 点の選択を外す |
| Ctrl/Cmd + Z | 元に戻す |
| Ctrl/Cmd + Shift + Z、Ctrl/Cmd + Y | やり直す |

#### 再生(p5.js のグローバルモードのみ)

| 操作 | 動き |
|---|---|
| Space(ポインタがパネルの上にあるとき) | 一時停止・再開 |
| ← →(一時停止中、点を選んでいないとき) | 1 コマ送る。Shift で 10 コマ |
| 再生位置の三角をドラッグ | 一時停止して、好きなコマへ動かす。一時停止中は線のどこをつかんでもよい |

止まるのは `frameCount` だけ。`deltaTime` や `millis()` で動かしている部分は止まらない。

## API

### `FrameEase(name)`

イージングを作る。値は `FrameEase.importState()` から読む。

### `move(frame)`

そのフレームの値。0 から 1 へ進む。曲線によっては 1 より上、0 より下にも。

p5.js の `frameCount` は 1 から始まるので、0 から始めたいときは `move(frameCount - 1)` と書く。

秒で動かすときは `move(millis() / (1000 / getTargetFrameRate()))`。

### `move(frame, { index, between })`

`index` は、`stagger` の分だけ index ごとにずらす。
`between` は、2本の曲線を補間する。0 で1本目、1 で2本目。時間の設定は共通。2本目は GUI で作る。

```js
move(frameCount, { index: i });                  // 並びごとに時間をずらす
move(frameCount, { index: i, between: i / 9 });  // 並びごとに形も変える
move(frameCount, { between: mouseX / width });   // マウスで形を変える
```

### `move.curve(t)`

曲線の t(0〜1)の位置の値。

### `FrameEase.gui()`

GUI を表示。公開するときはこの行を削除。

### `FrameEase.importState(state)`

値はここに書く。GUI のコピーボタンで出てくる形。
手で書いてもよい。書ける項目は Options のとおり。

```js
// ---- frame-ease state ----
FrameEase.importState({
  move: { duration: 60, loopDelay: 20, loop: true, alternate: true, points: '.4 .35, .7 1.06' }
});
// ---- frame-ease state end ----
```

スケッチはいつもコードの値で動く。貼らずに再読み込みすると、元の値に戻る。

## Options

`importState` に書く項目。

| Name | Default | Description |
|---|---|---|
| `duration` | `60` | 動きのフレーム数 |
| `delay` | `0` | 最初の1回だけ、始まる前に待つフレーム数 |
| `loopDelay` | `0` | 動いたあとに止まるフレーム数 |
| `stagger` | `0` | `index` ごとにずらすフレーム数 |
| `loop` | `false` | くり返し |
| `alternate` | `false` | `true` で往復。`'mirror'` で帰りを点対称の曲線に |
| `points` | `''` | 途中の点。`'x y, x y'` の形 |
| `startSlope` | 自動 | 始まりの傾き |
| `endSlope` | 自動 | 終わりの傾き |
| `endY` | `1` | 終わりの値 |
| `between` | なし | 2本目の曲線 |

### Files

| File | Description |
|---|---|
| `frame-ease.min.js` | GUI あり。制作中に |
| `frame-ease.core.min.js` | GUI なし。公開する作品に |
| `frame-ease.js` | 圧縮なし |

## Limitations

- フレーム数で数えるので、フレームレートが落ちると動き終わるまでの時間がのびる
- p5.js なしでも使える。秒に 60 を掛けて渡す(`move(seconds * 60)`)
- 一時停止・コマ送り・スクラブは p5.js のグローバルモードのみ

## License

MIT。GUI の曲線のプリセットは、Robert Penner の Easing Equations(BSD-3-Clause)をもとにしている。詳しくは [LICENSE](LICENSE)。
