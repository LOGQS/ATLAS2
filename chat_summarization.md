# Chat Summarization Feature

This document describes the chat summarization and condensation workflow introduced in the latest update.

## Overview
Users can generate a bullet‑point summary of any chat and optionally replace the chat history with that summary to reduce context length.

## Backend Implementation
- **System Prompt** – the summarization prompt is defined in `Backend/utils/prompts.py`:
  ```python
  summary_system_instruction = "Summarize the conversation in concise bullet points."
  ```
- **Summary Generation** – `Backend/app.py` provides `generate_chat_summary` which sends chat messages to the model:
  ```python
  def generate_chat_summary(messages, model_name):
      client = get_openai_client_for_model(model_name)
      openai_messages = [{"role": "system", "content": summary_system_instruction}]
      for msg in messages:
          role = msg.get("role")
          content = msg.get("content", "")
          if role in ["user", "assistant"]:
              openai_messages.append({"role": role, "content": content})
      response = client.chat.completions.create(
          model=model_name,
          messages=openai_messages,
          stream=False,
      )
      return response.choices[0].message.content.strip()
  ```
- **API Routes**:
  - `GET /api/chat/<chat_id>/summary` gathers the messages and returns the generated summary.
  - `POST /api/chat/<chat_id>/condense` replaces the chat history with the provided summary.

## Frontend Implementation
- **State Variables** – `Chat.tsx` tracks summarization progress and modal display:
  ```tsx
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [summaryContent, setSummaryContent] = useState('');
  ```
- **Summarize Function** – `summarizeChat` fetches the summary from the backend and opens the modal:
  ```tsx
  const summarizeChat = async () => {
      if (!chatId) return;
      setIsSummarizing(true);
      try {
          const summary = await chatManager.getChatSummary(chatId, model);
          setSummaryContent(summary || 'No summary available.');
      } catch (error) {
          console.error('Failed to summarize chat:', error);
          setSummaryContent('Failed to generate summary.');
      } finally {
          setIsSummarizing(false);
          setSummaryModalOpen(true);
      }
  };
  ```
- **Use Summary** – clicking the modal’s “Use Summary” button calls `useSummaryAsHistory` to condense the chat:
  ```tsx
  const useSummaryAsHistory = async () => {
      if (!chatId || !summaryContent) return;
      const success = await chatManager.condenseChat(chatId, summaryContent, model);
      if (success) {
          setMessages([{ role: 'system', content: summaryContent, isHistory: true }]);
          setSummaryModalOpen(false);
          window.dispatchEvent(new CustomEvent('chat-updated', { detail: { chatId } }));
      } else {
          alert('Failed to replace chat history with summary.');
      }
  };
  ```
- **Header Button** – a “Summarize” button is displayed in the chat header:
  ```tsx
  <button
      onClick={summarizeChat}
      className="summary-button"
      title="Summarize chat"
      disabled={isSummarizing}
  >
      {isSummarizing ? 'Summarizing...' : 'Summarize'}
  </button>
  ```
- **Summary Modal** – the modal shows the summary and provides the optional action:
  ```tsx
  <SummaryModal
      isOpen={summaryModalOpen}
      onClose={() => setSummaryModalOpen(false)}
      summary={summaryContent}
      onUseSummary={useSummaryAsHistory}
  />
  ```
- **Chat Manager Helpers** – `chatManager.ts` wraps the backend routes:
  ```ts
  public async getChatSummary(id: string, model: string): Promise<string | null> {
      const response = await fetch(`/api/chat/${id}/summary?model=${encodeURIComponent(model)}`);
      const data = await response.json();
      return data.summary as string;
  }

  public async condenseChat(id: string, summary: string, model: string): Promise<boolean> {
      const response = await fetch(`/api/chat/${id}/condense`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary, model })
      });
      await this.refreshChats();
      return response.ok;
  }
  ```
- **Styles** – `.summary-button` styles are defined in `index.css`.

## Usage
1. Click **Summarize** in the chat header to request a summary of the conversation.
2. A modal appears displaying bullet points summarizing the discussion.
3. Choose **Use Summary** to replace the entire chat history with this single system message.
4. The chat window now contains only the condensed summary, reducing token consumption for subsequent interactions.
