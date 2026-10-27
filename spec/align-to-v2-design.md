# Absolute Align To 設計ドキュメント

## 1. 背景・目的

既存の [Align To](https://www.figma.com/community/plugin/742450159822269057/align-to) プラグインは、選択レイヤーの1つを基準に他のレイヤーを整列させる機能を持つが、以下の課題がある。

- メンテナンスが止まっている
- 別フレームにまたがる選択の場合、意図しない位置に移動する

原因は、多くの旧実装が `node.x` / `node.y`（親ノードからの相対座標）を直接読み書きしており、選択レイヤーの親フレームが異なると座標系が噛み合わなくなるためと推定される。本設計では、この座標系の問題を解消したゼロベースの再実装を行う。

## 2. スコープ（今回の対応範囲）

| 項目 | 方針 |
|---|---|
| 整列パターン | 左揃え／右揃え／上揃え／下揃え／水平中央／垂直中央の基本6方向のみ |
| 等間隔配置（distribute） | 非対応（将来拡張の余地として残す） |
| 回転レイヤー・回転フレーム | 非対応（回転なし前提でシンプルに実装） |
| UI形式 | Custom UI（パネル表示、元プラグインと同様の体験） |
| UI言語 | 英語 |
| エディタ種別 | Figma Design（`editorType: ["figma"]`） |

## 3. 用語

- **Key object**：整列の基準として固定されるレイヤー。他のレイヤーはこのレイヤーの位置に合わせて移動する。（旧プラグインの「基準レイヤー」に相当する概念だが、UI上・コード上とも `key object` の呼称で統一する）

## 4. コア設計：座標系の扱い

回転非対応のため、行列計算は不要。以下の単純な往復変換で成立させる。

```
absoluteBoundingBox（ページ空間の絶対座標）
   → key object を基準に、各レイヤーの新しい絶対座標を算出
   → 各レイヤーの親の absoluteBoundingBox を使って親相対座標に変換
   → node.x, node.y に書き戻す
```

すべてのノードを一度ページ直下の絶対座標に正規化してから計算するため、選択レイヤーがどのフレームに属していても正しく整列できる。

回転がかかったノードは `absoluteBoundingBox` と見た目のバウンディングボックスがズレるが、本バージョンでは非対応と割り切り、特別なガードは設けない（将来的に `rotation !== 0` を検出して警告を出す拡張ポイントとして設計上は意識しておく）。

## 5. データフロー

```
[code.ts（メインスレッド）]                [ui.html]
selection changeを検知 ─────────────→ 選択中レイヤー一覧を表示
                                        ユーザーが key object をクリック指定
                                        整列方向ボタンを押下
key object ID + direction を受信 ←──── postMessageで送信
整列計算・ノードのx, y書き換え
（closeAfter = UI のチェックボックス「Close after aligning」の状態も同梱）
closeAfter かつスキップ・警告無し ─→ closePlugin(トースト) で終了
それ以外 ───────────────→ align-result を UI に返して表示（UI は開いたまま）
```

## 6. manifest.json（設計イメージ）

```json
{
  "name": "Absolute Align To",
  "id": "（公開時にFigmaが発行する新規ID）",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "enableProposedApi": false,
  "documentAccess": "dynamic-page",
  "editorType": ["figma"],
  "capabilities": [],
  "networkAccess": {
    "allowedDomains": ["none"]
  }
}
```

ネットワークアクセスは不要だが、`manifest.json` の仕様に合わせて `networkAccess.allowedDomains` を `["none"]` に固定する（CLAUDE.md 準拠）。

`documentAccess: "dynamic-page"` を指定しているため、同期 API の `figma.getNodeById` は使用できない。key object は `figma.currentPage.selection` を走査して解決する。また、UI からの準備完了通知（`ui-ready` ハンドシェイク）を受けてから最初の selection スナップショットを送ることで、`showUI()` 直後の早期送信の取りこぼしを防ぐ。

## 7. ファイル構成

```
code.ts          … メインスレッド。selection監視、UIとのpostMessage、整列計算、実処理の呼び出し
ui.html          … 選択レイヤー一覧表示、key object指定、方向ボタンのイベント処理（インラインJS）
manifest.json
tsconfig.json
package.json
```

Figma Plugin API は単一スクリプトとして実行されるため、バンドラを導入せず `code.ts` 単体で完結させる。整列計算ロジックは `code.ts` 内の内部関数として実装。UI ロジックも `ui.html` にインラインで記述する。

## 8. 整列計算の主要関数（code.ts 内の内部関数）

```typescript
type AlignDirection = "left" | "right" | "top" | "bottom" | "centerH" | "centerV";

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * key object の絶対座標を基準に、移動対象レイヤーの新しい絶対座標（ページ空間）を算出する
 */
const computeTargetPosition = (
  keyObjectBox: Rect,   // key object の absoluteBoundingBox
  movingBox: Rect,      // 移動対象レイヤーの absoluteBoundingBox
  direction: AlignDirection
): { x: number; y: number } => { /* ... */ };

/**
 * ページ空間の絶対座標を、親の絶対原点（ページ空間）を使って親相対座標に変換する
 *
 * 回転・スケール非対応（§4）のため、親の軸はページ空間と一致し、原点差分の単純減算で求まる。
 * 変換には親の「原点」のみを使う（width/height は不要）。呼び出し側は必ず
 * 「書き込み直前に読み直した」親原点を渡すこと（handleAlign 参照）。
 */
type Point = { x: number; y: number };

const absoluteToRelative = (
  absolutePos: Point,
  parentAbsoluteOrigin: Point
): Point => { /* ... */ };
```

これらはエクスポートせず `code.ts` 内でのみ使用する。`absoluteToRelative` は実装では `Point`（親の原点）を受け取る。仕様上は `Rect` としていたが原点以外は未使用のため `Point` に改めた。

## 9. 仕様上の考慮点

### 9.1 基本仕様（常に成り立つルール）

| 項目 | 仕様 |
|---|---|
| key object の扱い | key object として指定したレイヤーは位置を固定したまま、整列の移動対象（位置を書き換える対象）からは常に除外する |
| グループ内のノード | 通常ノードと同様に `absoluteBoundingBox` を持つため特別扱い不要 |
| 種類混在（テキスト・フレーム・コンポーネント等） | AABBベースの計算のため種類を問わず統一的に扱える |

### 9.2 エッジケース（要検討事項）

| ケース | 方針 |
|---|---|
| 選択レイヤーが1つのみ | Alignボタンを非活性にする（実行不可） |
| Auto Layout配下のレイヤー | Auto Layoutが有効な親（`layoutMode` が `NONE` 以外。`HORIZONTAL` / `VERTICAL` / `GRID` を含む）を持つ子は `x, y` の直接書き換えが無視される／自動的に戻される可能性があるため**非対応とする**。移動対象にAuto Layout配下のレイヤーが含まれる場合は、UI上で警告を表示し、そのレイヤーは整列処理をスキップする |
| key object が削除・選択解除された場合 | Plugin APIにはキャンバス操作（削除等）をロックする手段がないため、削除・選択解除を検知した際にUI上で警告を表示し、key objectの再指定を促す |
| locked ノード | 事前スキップはしない。`x / y` 書き込みの可否は Figma 側の挙動に従い、例外が発生した場合はそのメッセージをスキップ理由として UI に表示する |
| Auto Layout の `layoutPositioning === "ABSOLUTE"` 子 | 技術的には `x, y` を直接書き換えられるが、本バージョンでは保守的に「Auto Layout 子はすべてスキップ」とする（将来拡張点） |
| 親に `absoluteBoundingBox` が無い場合 | 親の絶対原点を取得できないため、そのレイヤーはスキップする |
| `x / y` 書き込み時の例外（INSTANCE の子など） | 例外メッセージをスキップ理由に変換し、バッチ全体は中断せず残りのレイヤーを処理する |

### 9.3 実装が追加で担保する挙動

- **key object の祖先は移動しない**：祖先を動かすと key object が道連れになり「key object を固定する」ルールが壊れるため、選択に含まれていてもスキップする。
- **key object が GROUP / BOOLEAN_OPERATION のときは子孫もスキップ**：これらの型は bounds が子から導出されるため、子孫を動かすと key object 自身の box が変化して基準がずれる。FRAME の子は枠の端に揃える用途を維持するため移動可とする（FRAME は明示サイズを持ち、子移動では resize しない）。
- **書き込み順序**：読み取り（Pass1）と書き込み（Pass2）を分離し、Pass2 では書き込み直前に key object の box と親の絶対原点を読み直す。祖先を先に書き、子はその後に書く（`getNodeDepth` 昇順）。
- **key box の変化検知**：整列中に key object の box が変化した場合（例：共有グループの再配流）は、結果に warning を付けて検証を促す。
- **整列対象の GROUP / BOOLEAN_OPERATION 内の子孫はスキップ**：コンテナと子孫が両方とも整列対象のとき、子孫の移動でコンテナの bounds が変わりコンテナの整列が崩れるため、子孫をスキップして理由を UI に表示する。
- **`moved` の数え方**：書き込み後の `absoluteBoundingBox` が元のページ空間位置から実質変化したレイヤーのみを `moved` として数える（微小変化は許容誤差以下なら数えない）。親相対の `x / y` は、グループ内の子を動かすとグループ原点も動き変化しないことがあるため判定に使わない。変化が無くスキップも無い場合は「Already aligned.」を通知する（下記「整列後の終了」参照）。

**整列後の終了**：UI の「Close after aligning」チェックボックス（初期値 ON、方向ボタンの上）が ON で、かつスキップも警告も無く正常終了した場合は `figma.closePlugin(message)` でプラグインを閉じ、結果をトーストで通知する（`Aligned N layer(s).`、変化が無ければ `Already aligned.`）。OFF の場合、およびスキップまたは key box 変化の警告がある場合は閉じず、UI に結果・理由を表示する（連続操作向け）。チェック状態は永続化しないため、プラグインを開き直すと ON に戻る。`closeAfter` は `align` メッセージで送り、`code.ts` 側は `true` のときだけ有効とみなす。

## 10. UI設計（構成イメージ）

```
┌─────────────────────────────┐
│ Selected layers (3)          │
│  ○ Rectangle 1                │
│  ● Rectangle 2  [Key object]  │
│  ○ Text Layer                 │
├─────────────────────────────┤
│ [x] Close after aligning      │
│ [Left] [Center H] [Right]     │
│ [Top]  [Center V] [Bottom]    │
└─────────────────────────────┘
```

- Key object の指定はラジオボタン的に1つのみ選択可能。
- 選択変更はFigma側の `selectionchange` イベントを受けて、UI側のレイヤー一覧を都度更新する。
- ボタンラベルは英語表記（Left / Right / Top / Bottom / Center H / Center V）。
- 警告領域（`#warning`）は最後に設定した内容を表示する。selection 更新時は「key object を見失った」警告を優先し、それ以外ではクリアする。整列実行後はスキップ理由／key box 変化の警告を表示する。
- レイヤー一覧の再描画時はスクロール位置を保持し、直前までリスト内にフォーカスがあった場合は選択中のラジオへフォーカスを戻す。
