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
| 等間隔配置（distribute） | 対応（`Space H` / `Space V` + px 入力欄）。key object 基準。**選択レイヤー全体（key object を含む）が同一親ノード配下であることが必要**。ただしこれは必要条件の一つであり、無効条件の一覧は §9.2、仕様詳細は §9.4 を参照 |
| 回転レイヤー・回転フレーム | 非対応（回転なし前提でシンプルに実装。distribute も同様に非対応） |
| 間隔入力 UI | 枠線付き数値入力欄を併設（単位 `px` は枠の外側＝右隣にラベル表示）。空欄時は既存ギャップの平均で均等化する（§9.4.3） |
| UI形式 | Custom UI（パネル表示、元プラグインと同様の体験） |
| UI言語 | 英語 |
| エディタ種別 | Figma Design（`editorType: ["figma"]`） |

## 3. 用語

- **Key object**：整列の基準として固定されるレイヤー。他のレイヤーはこのレイヤーの位置に合わせて移動する。（旧プラグインの「基準レイヤー」に相当する概念だが、UI上・コード上とも `key object` の呼称で統一する）
- **distribute（等間隔配置）**：選択レイヤーを等間隔に並べる操作の総称。UI 上は `Space H`（水平方向）と `Space V`（垂直方向）の2つのボタンで提供する。
- **spacing（間隔）**：ページ絶対空間における隣接ボックスのギャップ（前の要素の右端／下端から、次の要素の左端／上端までの距離）。px 入力欄の値もこの意味で解釈する（§9.4）。
- **同一親ノード**：**選択レイヤー全体（key object を含む）** の `parent` がすべて同一のノードであること。distribute の可否はこの単位で判定する（フレーム単位では判定しない）。判定は §9.3 のスキップ規則を適用する**前**の選択全体に対して行う（§9.2）。

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

distribute（§9.4）も同じ手順を通す。すなわち、ページ絶対空間で各レイヤーの目標座標を算出し、書き込み直前に読み直した親の絶対原点で親相対座標に変換してから `node.x` / `node.y` に書く。同一親ノード制約（§9.2）があっても近道はせず、align と同一の経路に乗せて座標系の扱いを一本化する。

この往復変換自体は親が異なっていても成立する（親ごとに絶対原点を読み直すため）。したがって distribute で同一親ノードを要求するのは座標変換の都合ではない。理由は、issue の要求（複数のフレームにまたがる選択は使用不可）を「選択レイヤーの親が異なる場合は使用不可」として保守的に一般化した**製品判断**である。この一般化は issue の条件を包含するが、同一フレーム内で別グループに分かれた選択も不可にする（issue より厳しい。緩和の要否は §9.4 の `TODO(distribute):` を参照）。

親の絶対原点は「直接の親」ではなく、**GROUP / BOOLEAN_OPERATION を飛ばして最初に見つかる祖先（フレーム・ページ等）**の `absoluteBoundingBox` から取る。Figma ではこれらの型は座標系を持たず、子の `x` / `y` は最も近いそれ以外の祖先を基準に表現されるためである（Plugin API の `relativeTransform` の説明を参照）。直接の親の box を原点にすると、グループ内のレイヤーが大きくずれる。この原点は子の移動でグループの bounds が変わっても動かないが、align の Pass2 では念のため書き込み直前に読み直す。distribute も同じ経路を通る。移動対象側の box を書き込みごとに読み直す必要はない（§9.4.6）。§9.3 の key box 変化検知が対象とするのは key object の box だけであり、移動対象側の box 変化は拾わないが、同一親制約下では許容する。

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

### 5.1 distribute

align と同じ経路（UI → main → 結果返却）を使う。差分は次のとおり。

```
入力欄に spacing を入力（任意）→ Space H / Space V を押下
  ├ UI 側で事前評価できる無効条件に該当 → ボタンが disable のため送信しない（理由を `#distribute-hint` に表示）
  └ 該当しない → postMessage で送信（`{ type: "distribute", axis, keyObjectId, spacing, closeAfter }`）
        ├ 実行時に確定する無効条件（スキップ後の移動対象が 2 つ未満／自動間隔で平均ギャップが負）に該当 → **計算も x / y 書き換えも行わず**、理由を `distribute-result` で返す
        └ 該当しない → distribute 計算・ノードの x, y 書き換え → 結果を `distribute-result`（または closePlugin のトースト）で返す
```

- 無効条件の判定は、`node.x` / `node.y` の書き換えより**前**に必ず完了させる。align 側 §5 で「計算・書き換え」の後に置かれている closeAfter 判定や結果返却は*実行後の分岐*だが、distribute の無効条件は*実行前の関門*であり、同じ位置に置いてはならない。
- **メッセージ形（決定）**：`align` に相乗りさせず、専用の `distribute` メッセージにする。ペイロードは `{ type: "distribute", axis: "horizontal" | "vertical", keyObjectId: string, spacing: number | null, closeAfter: boolean }`。`spacing` の `null` は空欄（自動間隔）を表す。align の `direction` と混同しないよう `axis` と命名する（UI ラベルは `Space H` / `Space V`）。
- **`closeAfter`（決定）**：align と同じく適用する。ON かつスキップ・警告なしの正常終了時のみ `figma.closePlugin(message)` で閉じ、それ以外は UI に結果を表示する。
- **判定の責務（決定）**：UI 側と main 側の両方で行う。UI は事前評価できる条件でボタンと入力欄を disable し、理由を表示する（UX のため）。main は受信時に**全条件（事前評価分の再検証を含む）**を書き換え前に再判定し、最終的な可否を決める（UI を信頼しない）。重複は許容する（align の「選択 2 つ未満」二重ガードと同じ方針）。
- **結果メッセージ（決定）**：`distribute-result`（`{ type: "distribute-result", moved: number, skipped: { id: string; reason: string }[], warning?: string }`）を新設し、`align-result` と同じ形にする。既存の `align-result` の名前は変更しない。
- **実行時拒否の表現（決定）**：実行時に確定する無効条件（スキップ後の移動対象が 2 つ未満／自動間隔で平均ギャップが負）や受信値の不正は、専用の型を増やさず `moved: 0` / `skipped: []` / `warning: 理由` で返す。UI はこの組み合わせを「Already distributed.」ではなく拒否として扱い、`#warning` に理由を表示する（「変化が無くスキップも無い」場合と区別するため）。
- **文言（決定）**：成功時は `Distributed N layer(s).`、変化が無くスキップも無い場合は `Already distributed.`。スキップ理由と warning の表示方法は align と同じ（`#warning` と `#status`）。

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

## 8. 計算ロジック（align / distribute、code.ts 内の内部関数）

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

distribute 用にも、Figma API に依存しない純関数を追加する。ページ絶対空間で各レイヤーの目標座標を返し、親相対への変換は既存の `absoluteToRelative` を再利用する。識別子は以下で確定する（UI ラベルの `Space H` / `Space V` はコード上の名前ではない）。

```typescript
type DistributeAxis = "horizontal" | "vertical";

// 並び順は呼び出し側（Figma 側）で確定して渡す。タイブレークに
// `parent.children`（レイヤーパネル順）が必要なため、純関数には
// Figma API を持ち込まない。
type DistributeItem = { id: string; rect: Rect };

/**
 * 並び順済みの要素（key object を含む）から、移動対象ごとの新しい
 * ページ絶対座標（左上）を返す。key object は戻り値に含めない。
 * 戻り値の各点は absoluteToRelative で親相対に変換して書き込む。
 */
const computeDistributedPositions = (
  axis: DistributeAxis,
  orderedItems: readonly DistributeItem[], // key object + 移動対象、軸方向の昇順
  keyObjectId: string,
  spacing: number | null, // null = 空欄（自動間隔）
): Map<string, Point> => { /* ... */ };
```

- 方向は `AlignDirection` と統合せず、独立した `DistributeAxis`（`"horizontal" | "vertical"`）にする。UI のボタンとは `data-axis` で対応させる。
- 軸と座標の対応：`axis === "horizontal"` は `x` と `width`、`"vertical"` は `y` と `height` を使う。非整列軸の座標は元の値を維持する。
- **入力値のバリデーション（決定）**：UI は入力欄の値を trim し、空文字なら `spacing: null`（自動）として送る。空でなければ `/^\d+(\.\d+)?$/`（非負・小数可）に一致することを確認し、一致しなければ送信せず入力欄の下（`#spacing-error`）にエラーを表示する（このエラーは入力の変更時・selection 変更時・distribute の無効化時にクリアする）。main は受信した `spacing` を `unknown` として再検証し、`null` か「有限かつ 0 以上の数値」以外は**計算前に**エラーを返す（`NaN` / `Infinity` / 負値 / 型違いを拒否）。0 は許可（ボックスが接する）、負値は許可しない。上限は設けず、小数はそのまま使う。

## 9. 仕様上の考慮点

### 9.1 基本仕様（常に成り立つルール）

| 項目 | 仕様 |
|---|---|
| key object の扱い | key object として指定したレイヤーは位置を固定したまま、整列の移動対象（位置を書き換える対象）からは常に除外する |
| グループ内のノード | 通常ノードと同様に `absoluteBoundingBox` を持つため特別扱い不要 |
| 種類混在（テキスト・フレーム・コンポーネント等） | AABBベースの計算のため種類を問わず統一的に扱える |

### 9.2 エッジケース（方針）

| ケース | 方針 |
|---|---|
| 選択レイヤーが1つのみ | Alignボタンを非活性にする（実行不可） |
| Auto Layout配下のレイヤー | Auto Layoutが有効な親（`layoutMode` が `NONE` 以外。`HORIZONTAL` / `VERTICAL` / `GRID` を含む）を持つ子は `x, y` の直接書き換えが無視される／自動的に戻される可能性があるため**非対応とする**。移動対象にAuto Layout配下のレイヤーが含まれる場合は、UI上で警告を表示し、そのレイヤーは整列処理をスキップする |
| key object が削除・選択解除された場合 | Plugin APIにはキャンバス操作（削除等）をロックする手段がないため、削除・選択解除を検知した際にUI上で警告を表示し、key objectの再指定を促す |
| locked ノード | 事前スキップはしない。`x / y` 書き込みの可否は Figma 側の挙動に従い、例外が発生した場合はそのメッセージをスキップ理由として UI に表示する |
| Auto Layout の `layoutPositioning === "ABSOLUTE"` 子 | 技術的には `x, y` を直接書き換えられるが、本バージョンでは保守的に「Auto Layout 子はすべてスキップ」とする（将来拡張点） |
| 親（GROUP / BOOLEAN_OPERATION は飛ばした祖先）に `absoluteBoundingBox` が無い場合 | 親の絶対原点を取得できないため、そのレイヤーはスキップする |
| `x / y` 書き込み時の例外（INSTANCE の子など） | 例外メッセージをスキップ理由に変換し、バッチ全体は中断せず残りのレイヤーを処理する |
| 選択レイヤーの親が異なる（distribute） | **distribute を機能ごと無効化する**（align は従来どおり実行可能）。判定は「選択レイヤー全体（key object を含む）の `parent` がすべて同一か」を、§9.3 のスキップ規則を適用する**前**の選択全体に対して行う。**フレーム単位では判定しない**。issue の「複数フレームにまたがる選択」はこの条件に包含される（フレームが異なれば親も異なる）。フレーム直下の兄弟は同一フレーム＝同一親なので可、同一フレーム内でも別グループに分かれていれば親が異なるため不可、ページ直下の兄弟は親が `PageNode` で共通のため可。UI 上で理由を表示する。issue の受け入れ条件を超える制限だが、この制約を維持することを決定済み（§9.4.7） |
| 選択レイヤーに Auto Layout 配下のレイヤーを含む（distribute） | **distribute を機能ごと無効化する**。判定対象は上と同じくスキップ規則適用前の選択全体とする。align が「該当レイヤーをスキップして継続」なのに対し、distribute では対象から除外すると残りだけで間隔を計算した結果が利用者の選んだ並び・間隔と食い違うため、機能全体を無効にする（計算不能だからではない）。key object だけを例外にする規則は設けない：同一親制約（前行）により、移動対象のいずれかが AL 子なら全選択が同じ AL 親の子になり、key object も AL 子になる。key object を例外にしても救えるケースは生じない（到達不能な規則を作らない） |
| 選択が 3 つ未満（distribute） | 無効。distribute には key object 以外に最低 2 つの移動対象が必要（key object + 移動対象 2 つ以上＝選択 3 つ以上）。これもスキップ規則適用前の選択数で数える |
| スキップ規則の適用後、実効的な移動対象が 2 つ未満になる（distribute） | 無効。key object の祖先や GROUP / BOOLEAN_OPERATION の子孫をスキップした結果、移動対象が 2 つ未満になると、並び順・間隔の基準が利用者の意図と一致しないため実行しない（理由を UI に表示する）。この条件はクリック前には確定しないため、UI の disable では表現できず、実行時に main 側で判定して書き換え前に打ち切る（§5.1・§10） |
| 空欄（自動間隔）で、並び順で隣接する要素間のギャップの平均が負になる（distribute） | 無効。元の配置が重なっていると、負のギャップで配置した結果、並びが逆転して順序の保証が崩れるため実行しない（理由を UI に表示する）。明示 spacing（`s >= 0`）なら実行できる。この条件もクリック前には確定しないため、実行時に main 側で判定して書き換え前に打ち切る（§9.4.3） |

### 9.3 実装が追加で担保する挙動

- **key object の祖先は移動しない**：祖先を動かすと key object が道連れになり「key object を固定する」ルールが壊れるため、選択に含まれていてもスキップする。
- **key object が GROUP / BOOLEAN_OPERATION のときは子孫もスキップ**：これらの型は bounds が子から導出されるため、子孫を動かすと key object 自身の box が変化して基準がずれる。FRAME の子は枠の端に揃える用途を維持するため移動可とする（FRAME は明示サイズを持ち、子移動では resize しない）。
- **書き込み順序**：読み取り（Pass1）と書き込み（Pass2）を分離し、Pass2 では書き込み直前に key object の box と親の絶対原点を読み直す。祖先を先に書き、子はその後に書く（`getNodeDepth` 昇順）。
- **key box の変化検知**：整列中に key object の box が変化した場合（例：共有グループの再配流）は、結果に warning を付けて検証を促す。
- **`moved` の数え方**：書き込み後の `absoluteBoundingBox` が元のページ空間位置から実質変化したレイヤーのみを `moved` として数える（微小変化は許容誤差以下なら数えない）。親相対の `x / y` ではなく絶対 box で判定する（親相対値は座標系の取り方に依存し、変化の判定に向かないため）。変化が無くスキップも無い場合は「Already aligned.」を通知する（下記「整列後の終了」参照）。

**整列後の終了**：UI の「Close after aligning」チェックボックス（初期値 ON、方向ボタンの上）が ON で、かつスキップも警告も無く正常終了した場合は `figma.closePlugin(message)` でプラグインを閉じ、結果をトーストで通知する（`Aligned N layer(s).`、変化が無ければ `Already aligned.`）。OFF の場合、およびスキップまたは key box 変化の警告がある場合は閉じず、UI に結果・理由を表示する（連続操作向け）。チェック状態は永続化しないため、プラグインを開き直すと ON に戻る。`closeAfter` は `align` メッセージで送り、`code.ts` 側は `true` のときだけ有効とみなす。

### 9.4 等間隔配置（distribute）の仕様

以下を確定とする（§9.2 の無効条件を満たす場合のみ実行可能）：

| 項目 | 仕様 |
|---|---|
| 実行方法 | UI の `Space H` / `Space V` ボタン。spacing の px 入力欄（空欄可）を併設する |
| spacing の入力欄 | `Space H` / `Space V` で**共通の 1 フィールド**を共有する（方向ごとに別の値は持たない） |
| 基準 | align と同様に key object 基準。key object は固定し、移動対象からは常に除外する |
| 無効条件 | §9.2 を参照（選択レイヤーの親が異なる／選択に Auto Layout 配下を含む／選択が 3 つ未満／スキップ後の移動対象が 2 つ未満／自動間隔で平均ギャップが負） |
| 無効条件の判定タイミング | UI 側で事前評価できる条件（親が異なる／Auto Layout 配下を含む／選択 3 つ未満）はボタンと入力欄を disable し、理由を `#distribute-hint` に表示する。実行時まで確定しない条件（スキップ後の移動対象が 2 つ未満／自動間隔で平均ギャップが負）は main 側で判定し、**計算と書き換えの前に**理由を返す（§5.1） |
| spacing の定義 | §3 のとおり、隣接ボックス間のギャップ（前の右端／下端から次の左端／上端まで）。px 指定値もこの意味で解釈する |
| 座標系 | §4 の手順（ページ絶対空間で算出 → 親相対へ変換）を align と共通で通す。同一親ノードでも近道はしない |
| 回転 | 非対応（align と同様、ガードは設けない） |
| `moved` の数え方 | align と同じ（書き込み後の `absoluteBoundingBox` が実質変化したレイヤーのみ数える） |

#### 9.4.1 並び順とタイブレーク（決定）

- 並び順は、§9.3 のスキップ規則を適用した**後**の集合（移動対象 + key object）に対して決める。スキップされたレイヤーは順序にも間隔にも参加しない。
- 軸方向の開始座標（`horizontal` なら `x`、`vertical` なら `y`）の昇順に並べる。
- 同値の場合は**ドキュメント順（`parent.children` 内のインデックス）の昇順**でタイブレークする。同一親制約により全選択が同じ親を共有するため順序は一意に決まり、レイヤーパネルの表示順とも一致する。
- key object も並びに含める（アンカーの位置を決めるため）。ただし移動はしない。

#### 9.4.2 key object の幾何的な意味（決定）

key object は**固定されたアンカー**であり、その位置は変更しない。並びを key object の前後で分割し、両側へ外向きに配置する。以下、`start` / `end` は軸方向の開始座標と終端座標（`horizontal` なら `x` と `x + width`）を指す。

- key object より手前（昇順で前）のレイヤー群を L、後ろのレイヤー群を R とする。
- L は key object の手前側へ、R は後ろ側へ配置する。
  - L のうち key object に最も近いレイヤーは、その終端が `key.start - s` になるように置く。さらに手前のレイヤーは、次のレイヤーの開始位置から `s` だけ離して置く。
  - R のうち key object に最も近いレイヤーは、その開始位置が `key.end + s` になるように置く。さらに後ろのレイヤーは、前のレイヤーの終端から `s` だけ離して置く。
- 明示 spacing では両側のレイヤーが key object を基準に詰められる（元のスパンは保持されない）。「間隔を s にする」という指定どおりの結果になる。
- key object が並びの端（先頭または末尾）にある場合は片側だけの配置になる。

#### 9.4.3 入力欄が空のとき（決定）

- 空欄（`spacing: null`）は**既存ギャップの平均**で均等化する。並び順で隣接する要素間のギャップを `g_i`（= 次の開始 − 前の終端）とすると、`s = (Σ g_i) / (n - 1)`（n は並び順済み集合の要素数）。
- この式は Figma 標準の Distribute spacing（両端を固定し `(スパン − 幅の合計) / (n - 1)` でギャップを決める）と同一である。したがって **key object が並びの端にある場合、結果は Figma 標準の Distribute spacing と完全に一致する**（key object が固定端になり、反対側の端も元の位置に収まる）。
- key object が中央にある場合、Figma 標準は両端を固定して key object を動かすが、本プラグインは key object を固定したまま両側を同じ平均ギャップで均等化する（ここが唯一の差異）。
- 元の配置が重なっている場合、平均ギャップは負になりうる。負のギャップで配置すると並びが逆転しうる（例: `(x, width) = (0,200), (20,10), (40,10)` で先頭が key のとき、平均は `-85` で 2 番目が `x=115`、3 番目が `x=40` になる）ため、**平均ギャップが負なら実行を拒否**する。main が計算・書き換えの前に判定し、理由を `distribute-result` で返す。ユーザーは明示 spacing（`s >= 0`）を入力すれば実行できる。
- 自動間隔の結果を入力欄へ書き戻さない（空欄のまま）。

#### 9.4.4 明示 spacing（決定）

- 入力値 `s >= 0` をそのまま使う。0 はボックスが接する状態。
- 負値・非数値は受け付けない（§8 のバリデーション）。UI で送信を止め、main でも再検証して拒否する。
- 小数はそのまま使う（丸めない）。上限は設けない。

#### 9.4.5 スキップ後の対象集合（決定）

- 並び順・間隔はスキップ後の集合だけで決める。スキップされたレイヤーの分の隙間は詰める（不在として扱う）。
- スキップ後に移動対象が 2 つ未満になった場合は実行しない。この判定は main が計算・書き換えの前に行い、理由を `distribute-result` で返す（§9.2）。

#### 9.4.6 子から bounds を導出する親（GROUP 等）配下での再流（決定）

- 同一親制約を維持する（§9.4.7）ため、移動対象同士が祖先・子孫の関係になることはない。
- 子（GROUP 等の直下）の `x` / `y` はグループではなく最も近い非グループ祖先が基準なので、子の移動でグループの bounds が変わっても座標系の原点は動かない。Pass1 で読んだ移動対象の絶対座標は書き込み後も有効で、**移動対象の box を書き込みごとに読み直す必要はない**。原点の取り方は §4 のとおり。
- 目標座標は Pass2 の開始時に一度だけ計算する。書き込み直前に親の絶対原点を読み直して `absoluteToRelative` に渡すのは align の Pass2 と同じ。
- key object の box は align と同様に再チェックし、変化していれば warning を付ける（同一親制約下では通常起こらない）。§9.3 の key box 変化検知が対象とするのは key object の box だけで、移動対象側の box 変化は拾わないが、上記の理由により許容する。

#### 9.4.7 同一親制約の扱い（決定）

- **緩和しない**。選択レイヤー全体（key object を含む）が同一親ノード配下であることを要求し続ける。
- 理由：issue の「複数のフレームにまたがる選択は不可」を保守的に一般化した製品判断であり、同一フレーム内の別グループも不可にする。座標変換自体は親が異なっても成立する（§4）ため、技術的制約ではなく仕様判断である。
- この制約により、移動対象同士の祖先・子孫関係と、グループ再流の影響（§9.4.6）が同時に排除される。

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
├─────────────────────────────┤
│ [Space H] [Space V]  ┌────┐   │
│                      │ 10 │ px│
│                      └────┘   │
└─────────────────────────────┘
```

- Key object の指定はラジオボタン的に1つのみ選択可能。
- 選択変更はFigma側の `selectionchange` イベントを受けて、UI側のレイヤー一覧を都度更新する。
- ボタンラベルは英語表記（Left / Right / Top / Bottom / Center H / Center V）。
- 警告領域（`#warning`）は最後に設定した内容を表示する。selection 更新時は「key object を見失った」警告を優先し、それ以外ではクリアする。整列実行後はスキップ理由／key box 変化の警告を表示する。
- レイヤー一覧の再描画時はスクロール位置を保持し、直前までリスト内にフォーカスがあった場合は選択中のラジオへフォーカスを戻す。
- spacing の数値入力欄は枠線付きのテキストボックスとして表示し、フォーカス時にハイライトする（入力欄であることが一目で分かるようにする）。単位 `px` は入力欄の枠の**外側（右隣）**にラベルとして表示する。
- spacing の入力欄は `Space H` / `Space V` で共通の 1 フィールドとする（§9.4）。
- `Space H` / `Space V` と spacing 入力欄は、**UI 側で事前評価できる無効条件**（選択レイヤーの親が異なる／選択に Auto Layout 配下を含む／選択が 3 つ未満）に該当するとき disable し、理由を `#distribute-hint` に表示する。行ごと非表示にはしない（理由が読めなくなるため）。
- key object が未指定の間も `Space H` / `Space V` と入力欄は disable する（整列ボタンと同じ）。
- **実行時まで確定しない無効条件**（スキップ規則の適用後に実効的な移動対象が 2 つ未満、または空欄の自動間隔で平均ギャップが負）は disable では表現できない。この条件だけはボタンを押せる状態のままにし、main 側が書き換え前に判定して理由を結果として返し、UI に表示する（§5.1）。§9.2 の全条件を disable で表現する、とは書かない。
- **無効理由の表示先（決定）**：`#warning` は実行結果・エラー用として維持し、事前評価による無効理由は Space 行の直下に専用の `#distribute-hint`（小さめ・ミュート色）を設けて表示する。disable の間だけ表示し、該当しなければ隠す。複数該当時は理由を列挙する。実行時の拒否理由は `#warning` に表示する。選択が 0 件のときは `#empty` が状況を説明するため `#distribute-hint` は表示しない（空選択では同一親判定が false になり「同一親」の理由がノイズになるため）。
- **spacing 入力のエラー表示（決定）**：書式エラーは `#warning` ではなく、入力欄の直下に専用の `#spacing-error`（小さめ・危険色）を設けて表示する。入力の変更時・selection 変更時・distribute が無効化された時にクリアする。
- **事前評価の責務（決定）**：UI 側で判定して disable し、main 側でも全条件を再判定する（§5.1・§9.4.5）。重複は許容する（align の二重ガードと同じ）。
- **入力値の永続化（決定）**：しない。プラグインを開くたびに空欄で開始する（`closeAfter` チェックボックスと同じ扱い）。
