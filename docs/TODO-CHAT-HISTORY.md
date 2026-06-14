# TODO: Chat History in Floating Overlay

## Current Behavior
- The overlay stores ONE question (`lastQuestion`) and ONE response (`aiResponse`) at a time
- When you send a new question, the previous Q&A pair is replaced
- This is the original design — "suggestion card" shows the latest AI suggestion only

## Desired Behavior (Cluely parity)
- Keep ALL Q&A pairs visible as a scrollable chat thread
- New messages append to the bottom
- Auto-scroll to the latest message
- The scroll body holds the full conversation history

## Implementation Plan

### State Change
Replace `lastQuestion: string | null` + `aiResponse: AIResponse | null` with:
```ts
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  isSimulated?: boolean;
  timestamp: number;
}

const [messages, setMessages] = useState<ChatMessage[]>([]);
```

### On Submit
```ts
// Add user message
setMessages(prev => [...prev, { id: genId(), role: 'user', text: query, timestamp: Date.now() }]);

// On AI response complete:
setMessages(prev => [...prev, { id: genId(), role: 'assistant', text: response.text, isSimulated: response.isSimulated, timestamp: Date.now() }]);
```

### Render
Replace the single `{lastQuestion && <UserBubble />}` + `<SuggestionCard />` with:
```tsx
<div className="card-scroll-body">
  {messages.map(msg => msg.role === 'user' 
    ? <UserBubble key={msg.id} text={msg.text} />
    : <AssistantBubble key={msg.id} text={msg.text} isSimulated={msg.isSimulated} />
  )}
  {isLoading && <ThinkingIndicator />}
  <div ref={scrollEndRef} /> {/* auto-scroll anchor */}
</div>
```

### Files to Touch
- `src/components/FloatingCopilot.tsx` — state + render
- `src/components/copilot/SuggestionCard.tsx` — refactor into `AssistantBubble`
- `src/components/FloatingCopilot.css` — chat bubble styles

### Notes
- The streaming text should render as the latest assistant message (in-progress)
- Clearing the chat on mode change is optional
- Memory is session-only (no IndexedDB persistence for chat — that's what meetings/transcripts are for)
