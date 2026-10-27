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
```

## 6. manifest.json（設計イメージ）

```json
{
  "name": "Absolute Align To",
  "id": "（公開時にFigmaが発行する新規ID）",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"],
  "capabilities": [],
  "permissions": []
}
```

ネットワークアクセスは不要のため `networkAccess` は設定しない。

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
 * ページ空間の絶対座標を、親の absoluteBoundingBox を使って親相対座標（node.x, node.y相当）に変換する
 */
const absoluteToRelative = (
  absolutePos: { x: number; y: number },
  parentAbsoluteBox: Rect
): { x: number; y: number } => { /* ... */ };
```

これらはエクスポートせず `code.ts` 内でのみ使用する。

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
| Auto Layout配下のレイヤー | Auto Layoutが有効な親を持つ子は `x, y` の直接書き換えが無視される／自動的に戻される可能性があるため**非対応とする**。移動対象にAuto Layout配下のレイヤーが含まれる場合は、UI上で警告を表示し、そのレイヤーは整列処理をスキップする |
| key object が削除・選択解除された場合 | Plugin APIにはキャンバス操作（削除等）をロックする手段がないため、削除・選択解除を検知した際にUI上で警告を表示し、key objectの再指定を促す |

## 10. UI設計（構成イメージ）

```
┌─────────────────────────────┐
│ Selected layers (3)          │
│  ○ Rectangle 1                │
│  ● Rectangle 2  [Key object]  │
│  ○ Text Layer                 │
├─────────────────────────────┤
│ [Left] [Center H] [Right]     │
│ [Top]  [Center V] [Bottom]    │
└─────────────────────────────┘
```

- Key object の指定はラジオボタン的に1つのみ選択可能。
- 選択変更はFigma側の `selectionchange` イベントを受けて、UI側のレイヤー一覧を都度更新する。
- ボタンラベルは英語表記（Left / Right / Top / Bottom / Center H / Center V）。
