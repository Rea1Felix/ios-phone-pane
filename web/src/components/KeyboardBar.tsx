import { useRef, useState } from "react";
import { BackspaceIcon, ReturnKeyIcon, SendIcon } from "../icons";
import type { PhoneKey } from "../types";

interface KeyboardBarProps {
  disabled: boolean;
  sending: boolean;
  onTypeText: (text: string) => Promise<void>;
  onSendKey: (key: PhoneKey) => Promise<void>;
}

export function KeyboardBar({
  disabled,
  sending,
  onTypeText,
  onSendKey,
}: KeyboardBarProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled || sending) return;
    if (text.length === 0) {
      await onSendKey("return");
      return;
    }
    const payload = text;
    setText("");
    await onTypeText(payload);
    inputRef.current?.focus();
  };

  return (
    <form className="keyboard-bar" onSubmit={handleSubmit} aria-label="傳送文字與按鍵到 iPhone">
      <div className="keyboard-input-wrap">
        <input
          ref={inputRef}
          type="text"
          className="keyboard-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="輸入文字傳送到 iPhone…"
          aria-label="輸入文字傳送到 iPhone"
          enterKeyHint="send"
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          className="kb-btn kb-btn-primary"
          disabled={disabled || sending || text.length === 0}
          aria-label="傳送文字"
          title="傳送文字"
        >
          <SendIcon width={14} height={14} />
          <span className="kb-btn-label">傳送</span>
        </button>
      </div>

      <div className="keyboard-quick-keys" role="group" aria-label="快捷按鍵">
        <button
          type="button"
          className="kb-btn"
          disabled={disabled || sending}
          onClick={() => void onSendKey("return")}
          aria-label="Enter 換行／送出"
          title="Enter (Return)"
        >
          <ReturnKeyIcon width={14} height={14} />
          <span className="kb-key-text">Enter</span>
        </button>
        <button
          type="button"
          className="kb-btn"
          disabled={disabled || sending}
          onClick={() => void onSendKey("backspace")}
          aria-label="Backspace 刪除字元"
          title="Backspace"
        >
          <BackspaceIcon width={14} height={14} />
          <span className="kb-key-text">刪除</span>
        </button>
      </div>
    </form>
  );
}
