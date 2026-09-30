import React, { useEffect, useRef } from "react";

import EditorJS from '@editorjs/editorjs';
import Header from '@editorjs/header';
import List from '@editorjs/list';
import ImageTool from '@editorjs/image';
import Code from '@editorjs/code';

import AiTool from './ai-tool';
import AiInlineTool from "./inline-ai-tool";

import useEditorStore from "../../store/use-editor-store";
import useResponseStore from "../../store/use-response-store";

export default function Editor() {
  const ejInstance = useRef();
  const {setContext} = useResponseStore();

  const getEditorInstance = () => {
    return ejInstance.current;
  };

  useEffect(() => {
    if (!ejInstance.current) {
      initEditor();
      // store the editor instance in the store
      ejInstance.current = getEditorInstance();
      useEditorStore.setState({api: ejInstance.current});
    }

    return () => {
        ejInstance.current = null;
    }
},[]);

const initEditor = () => {
  const editor = new EditorJS({
    holder: 'text-editor',
    tools: {
      AiTool: {
          class: AiTool,
          inlineToolbar: true,
      },
      header: {
        class: Header,
        inlineToolbar: true,
      }, 
      list: {
        class: List,
        inlineToolbar: true,
      },
      image: {
        class: ImageTool,
        inlineToolbar: true,
      },
      code: {
        class: Code,
        inlineToolbar: true,
      },
      AddContext: {
        class: AiInlineTool,
        shortcut: 'CMD+M',
      }
    },
    placeholder: 'Click here to write down the title',
    data: {
      blocks: []
    },
    onReady: () => {
      attachPlainTextPasteHandler(editor);
    },
  });
  ejInstance.current = editor;
};

/**
 * Intercepts plain-text paste events before Editor.js sees them and splits
 * the content into paragraph blocks on double newline boundaries.
 *
 * Without this, pasting plain ASCII produces garbled output because Editor.js's
 * internal paste pipeline doesn't split on paragraph breaks.
 *
 * Runs in the capture phase so it fires before Editor.js's own listeners,
 * which are attached to child elements in the bubble phase.
 */
function attachPlainTextPasteHandler(editor) {
  const holder = document.getElementById('text-editor');
  if (!holder) return;

  holder.addEventListener('paste', (e) => {
    const plain = e.clipboardData?.getData('text/plain');
    if (!plain?.trim()) return; // not plain text — let Editor.js handle it

    e.preventDefault();
    e.stopPropagation(); // prevent Editor.js from processing this paste

    // Split on one or more blank lines (paragraph boundary).
    // Collapse single newlines within a paragraph to a space since
    // Editor.js paragraph blocks don't support in-block line breaks.
    const paragraphs = plain
      .split(/\r?\n(?:\r?\n)+/)
      .map(p => p.replace(/\r?\n/g, ' ').trim())
      .filter(Boolean);

    if (!paragraphs.length) return;

    let idx = editor.blocks.getCurrentBlockIndex();

    // If the focused block is already empty, overwrite it with the first
    // paragraph instead of inserting a new block and leaving a dangling blank.
    const focusedEl = holder.querySelector('.ce-block--focused .ce-paragraph');
    if (focusedEl && !focusedEl.textContent.trim()) {
      const blockId = editor.blocks.getBlockByIndex(idx)?.id;
      if (blockId) {
        editor.blocks.update(blockId, { text: paragraphs[0] });
        for (let i = 1; i < paragraphs.length; i++) {
          editor.blocks.insert(
            'paragraph',
            { text: paragraphs[i] },
            {},
            idx + i,
            i === paragraphs.length - 1,
          );
        }
        return;
      }
    }

    // Default path: insert all paragraphs after the current cursor block.
    paragraphs.forEach((text, i) => {
      editor.blocks.insert(
        'paragraph',
        { text },
        {},
        idx + 1 + i,
        i === paragraphs.length - 1,
      );
    });
  }, true); // true = capture phase
}

const handleSelectionChange = (e) => {
  const selection = document.getSelection()
  // Ensure the selection exists, has content, and the anchorNode's parent is an element
  if (selection && selection.toString().trim().length > 0 && selection.anchorNode && (selection.anchorNode.parentElement || selection.anchorNode.parentElement.offsetParent)) {
    const classNames = selection.anchorNode.parentElement.className;
    const offsetClassNames = selection.anchorNode.parentElement.offsetParent.className
    // Check if classNames contain either "ce-paragraph" or "cdx-block"
    if (classNames.includes('ce-') || offsetClassNames.includes('ce-')) {
      setContext(selection.toString().trim())
    } else {
      setContext('');
    }
  }
}

  return (
    <div id="text-editor">
    </div> 
  );
}

