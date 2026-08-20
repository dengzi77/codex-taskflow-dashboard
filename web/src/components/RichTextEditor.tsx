import { useMemo } from "react";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CodeToggle,
  CreateLink,
  InsertCodeBlock,
  ListsToggle,
  MDXEditor,
  Separator,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  type Translation,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { LinearIcon } from "./LinearIcon";

interface RichTextEditorProps {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}

const translations: Record<string, string> = {
  "toolbar.blockTypes.paragraph": "正文",
  "toolbar.blockTypes.quote": "引用",
  "toolbar.blockTypes.heading": "标题 {{level}}",
  "toolbar.blockTypeSelect.selectBlockTypeTooltip": "段落样式",
  "toolbar.blockTypeSelect.placeholder": "段落样式",
  "toolbar.undo": "撤销",
  "toolbar.redo": "重做",
  "toolbar.bold": "加粗",
  "toolbar.removeBold": "取消加粗",
  "toolbar.italic": "斜体",
  "toolbar.removeItalic": "取消斜体",
  "toolbar.inlineCode": "行内代码",
  "toolbar.removeInlineCode": "取消行内代码",
  "toolbar.bulletedList": "无序列表",
  "toolbar.numberedList": "有序列表",
  "toolbar.checkList": "任务列表",
  "toolbar.link": "添加链接",
  "toolbar.codeBlock": "插入代码块",
};

const translate: Translation = (key, defaultValue, interpolations) => {
  let value = translations[key] ?? defaultValue;
  for (const [name, replacement] of Object.entries(interpolations ?? {})) {
    value = value.replaceAll(`{{${name}}}`, String(replacement));
  }
  return value;
};

export function RichTextEditor({
  value,
  disabled = false,
  onChange,
  onCancel,
  onSave,
}: RichTextEditorProps) {
  const plugins = useMemo(() => [
    headingsPlugin({ allowedHeadingLevels: [1, 2, 3] }),
    listsPlugin(),
    quotePlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    imagePlugin(),
    tablePlugin(),
    thematicBreakPlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
    codeMirrorPlugin({
      codeBlockLanguages: {
        "": "纯文本",
        bash: "Shell",
        css: "CSS",
        html: "HTML",
        javascript: "JavaScript",
        json: "JSON",
        typescript: "TypeScript",
      },
    }),
    markdownShortcutPlugin(),
    toolbarPlugin({
      toolbarClassName: "issue-rich-text-toolbar",
      toolbarContents: () => (
        <>
          <UndoRedo />
          <Separator />
          <BlockTypeSelect />
          <Separator />
          <BoldItalicUnderlineToggles options={["Bold", "Italic"]} />
          <CodeToggle />
          <Separator />
          <ListsToggle options={["bullet", "number", "check"]} />
          <CreateLink />
          <InsertCodeBlock />
        </>
      ),
    }),
  ], []);

  return (
    <div className="issue-description-editor-shell">
      <MDXEditor
        className="issue-rich-text-editor"
        contentEditableClassName="issue-rich-text-content"
        markdown={value}
        plugins={plugins}
        placeholder="添加描述…"
        readOnly={disabled}
        autoFocus={{ defaultSelection: "rootEnd", preventScroll: true }}
        translation={translate}
        onChange={(markdown, initialMarkdownNormalize) => {
          if (!initialMarkdownNormalize) onChange(markdown);
        }}
      />
      <div className="issue-rich-text-actions">
        <button type="button" title="取消" aria-label="取消编辑描述" disabled={disabled} onClick={onCancel}>
          <LinearIcon name="close" />
        </button>
        <button className="primary" type="button" title="保存" aria-label="保存描述" disabled={disabled} onClick={onSave}>
          <LinearIcon name="check" />
        </button>
      </div>
    </div>
  );
}
