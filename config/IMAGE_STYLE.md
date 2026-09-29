# 画風設定の書き方（config）

アプリの「設定」→「画風設定」で使う、画風指示のJSONの形式と各項目の説明です。

## 概要

- 画風設定は **画像生成プロンプトの先頭** に挿入され、**【厳守】** として扱われます。
- まんが生成・再生成・Inpaint、および単発投稿の画像生成のいずれでも、ここで指定した内容が最優先で適用されます。
- 画風設定が未設定・未選択の場合は、シリーズ設定の `art_style` → 設定の「画風」テキスト → デフォルトの順でフォールバックします。

## JSON の形式（2通り）

### 形式1: スタイルを複数登録（`styles` 配列）

```json
{
  "styles": [
    {
      "style_name": "スタイルの表示名",
      "core_concept": "コンセプトの短文説明",
      "attributes": { ... },
      "subject_placeholder": "描写の参考例（任意）"
    }
  ]
}
```

- アプリの画風設定で **スタイル名（style_name）** を選ぶと、その1件がプロンプトに使われます。
- 複数ある場合は先頭、または `image_style_selected` で指定した名前と一致するものが選ばれます。

### 形式2: 単一スタイル（`image_generation_prompt`）

```json
{
  "image_generation_prompt": {
    "style_name": "スタイルの表示名",
    "core_concept": "コンセプトの短文説明",
    "attributes": { ... },
    "subject_placeholder": "描写の参考例（任意）"
  }
}
```

- 1種類だけの画風を指定するときはこの形式でも構いません。
- 内部では `styles: [ このオブジェクト ]` と同等に扱われます。

## 各項目の説明

| 項目 | 必須 | 説明 | プロンプトでの見出し |
|------|------|------|----------------------|
| `style_name` | 推奨 | スタイルの表示名。画風設定のドロップダウンに表示される | 【画風名】 |
| `core_concept` | 任意 | 画風のコンセプトを一言で（英文・日本語どちらでも可） | 【コンセプト】 |
| `attributes` | 任意 | 下記のサブ項目で画材・線・彩色などを指定 | （下記のとおり） |
| `subject_placeholder` | 任意 | 描写の参考例（例: 「羽の生えた猫と笑う太陽」） | 【描写の参考例】 |

### `attributes` の中身（ここにまとめればすべてプロンプトに読み込まれます）

| サブ項目 | 型 | 説明 | プロンプトでの見出し |
|----------|-----|------|----------------------|
| `style_name` | 文字列 | スタイル名（attributes の外・スタイルの直下） | 【画風名】 |
| `core_concept` | 文字列 | コンセプト（attributes の外） | 【コンセプト】 |
| `color` | 文字列 | 色指定。`"白黒"` で白黒厳守（attributes の外） | 【色】＋【厳守】 |
| `medium` | 文字列 **または** 文字列の配列 | 画材 | 【画材】 |
| `visual_characteristics` | オブジェクト | 線・遠近・彩色 | 【線】【遠近・構図】【彩色】 |
| `visual_characteristics.line_work` | 文字列 | 線の質感 | 【線】 |
| `visual_characteristics.perspective` | 文字列 | 遠近・構図 | 【遠近・構図】 |
| `visual_characteristics.coloring_style` | 文字列 | 彩色の仕方 | 【彩色】 |
| `shading_technique` | 文字列 | 陰影・質感（版画の鑿跡など） | 【陰影・質感】 |
| `color_fill` | 文字列 | 彩色（インクの乗せ方など） | 【彩色】 |
| `line_quality` | 文字列 | 線の質（attributes 直下でも可） | 【線】 |
| `artistic_influence` | 文字列の配列 | 芸術的影響・ムーブメント | 【芸術的影響】 |
| `color_palette` | オブジェクト | `type` / `colors` 配列 / `contrast`。白黒は `type: "白黒"`, `contrast: "Extremely high"` など | 【色調】 |
| `composition_elements` | 文字列の配列 | 構成要素 | 【構成要素】 |
| `overall_mood` | 文字列 | 全体の雰囲気 | 【雰囲気】 |
| `background` | 文字列 | 背景の指定（和紙の質感など） | 【背景】 |
| `output_spec` | オブジェクト | `background` / `contrast` / `usability` | 【出力仕様】 |
| `contrast` | 文字列 | コントラストのみ指定する場合（output_spec の代わりに可） | 【出力仕様】 |
| `subject_placeholder` | 文字列 | 描写の参考例（attributes の外） | 【描写の参考例】 |

### 代替形式（`attributes` を使わない場合）

`attributes` の代わりに、次のキーも使えます。**画風が反映されない場合は、ここで書いた内容がプロンプトに含まれているか確認してください。**

| 項目 | 説明 | プロンプトでの見出し |
|------|------|----------------------|
| `base_concept` | `core_concept` と同様。コンセプトの短文（どちらか一方で可） | 【コンセプト】 |
| `color` | 色指定（例: `"白黒"`）。`"白黒"` / `"白黒のみ"` のときは白黒厳守の一文が追加される | 【色】＋【厳守】 |
| `aesthetic` | オブジェクト。`vibe` / `detail_level` / `complexity` を 1 行にまとめる | 【雰囲気・表現】 |
| `technical_execution` | オブジェクト。`medium` / `shading_technique` / `color_fill` / `line_quality` | 【画材】【陰影・質感】【彩色】【線】 |
| `output_specifications` | オブジェクト。`background` / `usability` / `contrast` | 【出力仕様】 |
| `medium_spec` | オブジェクト。`paper_type` / `drawing_tools` 配列 | 【画材・紙】 |
| `visual_logic` | オブジェクト。`lines` / `shading` / `perspective` / `coloring_style` | 【描画ロジック】 |

## サンプル

同梱の `config/image-style.example.json` を参照してください。
1つのスタイルを `image_generation_prompt` 形式で定義した例です。

### 例: attributes にまとめた版画スタイル（白黒・全て読み込まれる）

```json
{
  "style_name": "Elementary School Woodblock Print (Hanga)",
  "color": "白黒",
  "core_concept": "Woodblock print made by a child",
  "attributes": {
    "medium": "Monochrome woodblock print (Hanga)",
    "visual_characteristics": {
      "line_work": "Jagged, hand-carved edges, bold and thick lines",
      "perspective": "Flat 2D, simplified forms",
      "coloring_style": "Sumi ink black with uneven distribution"
    },
    "shading_technique": "Visible chisel marks, rough wood-carved textures",
    "color_fill": "Sumi ink black with uneven distribution, white speckles showing wood grain",
    "color_palette": {
      "type": "白黒",
      "contrast": "Extremely high contrast (Black and White)"
    },
    "overall_mood": "Naive and energetic folk art style. Simplified forms with bold expressions. Stark contrast between carved and inked areas.",
    "background": "Washi paper texture with subtle ink splatters",
    "output_spec": {
      "background": "Washi paper texture with subtle ink splatters",
      "contrast": "Extremely high contrast (Black and White)",
      "usability": "Artistic print style"
    }
  },
  "subject_placeholder": "白黒の版画。小学生の作った版画なので、ディテールの描写がなく下手くそで、線も荒いけれど、おおらかで味わいがある画風。A monochrome woodblock print made by a child, bold black sumi ink on washi paper, visible chisel marks and rough carved edges, uneven ink texture, simple energetic silhouette, naive art style, high contrast, rustic and handmade feel."
}
```

上記のように **`attributes` 内にまとめて書けば、画材・線・彩色・陰影・色調・雰囲気・背景・出力仕様まで全てプロンプトに読み込まれます。** トップレベルでは `style_name`・`color`・`core_concept`・`subject_placeholder` を指定します。

## 画風設定が使われる場所

- **まんが**: 生成・コマ再生成・Inpaint のプロンプト先頭（`getEffectiveDrawingStyleForComic()`）。
- **単発投稿の画像生成**: プロンプト先頭（画風設定があればその内容、なければ art_style / デフォルト）。

画風設定でスタイルを選択している間は、「【厳守】設定の「画風設定」で指定した以下の指示を厳密に守ること。」が前置され、その直後に上記の【画風名】【コンセプト】…が並びます。
