import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  createThread,
  decide,
  getApproval,
  getInbox,
  getThread,
  listUsers,
  login,
  sendMessage,
  type ApprovalDetail,
  type Attachment,
  type InboxItem,
  type ThreadView,
  type User,
} from './api.ts';
import { ApprovalSheet } from './ApprovalSheet.tsx';
import { ROLE_LABELS, ROLE_ORDER, STEP_LABELS } from './labels.ts';

const POLL_MS = 2500;
const EXAMPLE = '가람상사 청구서 A-2026-1101 300만 원 지급해 줘';
const PDF_EXAMPLE = '첨부한 청구서대로 지급해 줘';

const fileToAttachment = async (file: Blob, name: string): Promise<Attachment> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { name, base64: btoa(binary) };
};

const won = (amount: number) => `${amount.toLocaleString('ko-KR')}원`;

const describe = (error: unknown) => {
  if (error instanceof ApiError && error.status === 503) {
    return 'Claude API 키가 없어 대화할 수 없습니다. .env에 ANTHROPIC_API_KEY를 넣고 API 서버를 다시 실행하세요.';
  }
  if (error instanceof ApiError && error.code === 'INVALID_PDF') return 'PDF 파일을 읽지 못했습니다.';
  if (error instanceof ApiError && error.code === 'FILE_TOO_LARGE') return '5MB 이하의 PDF만 첨부할 수 있습니다.';
  if (error instanceof ApiError && error.status === 403) return '이 결재를 처리할 권한이 없습니다.';
  if (error instanceof ApiError && error.code === 'THREAD_BUSY') {
    return '결재가 끝나면 이어서 입력할 수 있습니다.';
  }
  if (error instanceof Error) return `요청을 처리하지 못했습니다. ${error.message}`;
  return '요청을 처리하지 못했습니다.';
};

export function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [threadIds, setThreadIds] = useState<Record<string, string>>({});
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [streamText, setStreamText] = useState('');
  const [stepText, setStepText] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokens = useRef(new Map<string, string>());
  const activeToken = useRef<string | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  const threadId = userId ? (threadIds[userId] ?? null) : null;
  const user = users.find((candidate) => candidate.id === userId);

  const selectUser = useCallback(async (id: string) => {
    setError(null);
    setApprovalId(null);
    setDetail(null);
    setThread(null);
    setStreamText('');
    try {
      const cached = tokens.current.get(id) ?? (await login(id));
      tokens.current.set(id, cached);
      activeToken.current = cached;
      setUserId(id);
      setToken(cached);
    } catch (cause) {
      setError(describe(cause));
    }
  }, []);

  useEffect(() => {
    listUsers()
      .then((list) => {
        const ordered = [...list].sort(
          (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.id.localeCompare(b.id),
        );
        setUsers(ordered);
        const first = ordered.find((candidate) => candidate.role === 'employee');
        if (first) void selectUser(first.id);
      })
      .catch(() => setError('API 서버에 연결할 수 없습니다. npm run dev로 서버를 실행하세요.'));
  }, [selectUser]);

  const refresh = useCallback(async () => {
    if (!token) return;
    const [nextInbox, nextThread] = await Promise.all([
      getInbox(token),
      threadId ? getThread(token, threadId) : Promise.resolve(null),
    ]);
    // 응답을 기다리는 사이 역할을 바꿨다면 이전 사용자의 결과를 버린다.
    if (activeToken.current !== token) return;
    setInbox(nextInbox);
    setThread(nextThread);
    if (nextThread?.approvalId) setApprovalId((current) => current ?? nextThread.approvalId);
  }, [token, threadId]);

  const refreshDetail = useCallback(async () => {
    if (!token || !approvalId) return;
    const next = await getApproval(token, approvalId);
    if (activeToken.current === token) setDetail(next);
  }, [token, approvalId]);

  useEffect(() => {
    if (sending) return undefined;
    const tick = () => {
      Promise.all([refresh(), refreshDetail()]).catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, refreshDetail, sending]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [thread?.messages.length, streamText, pendingText]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !token || !userId || sending) return;
    setError(null);
    setDraft('');
    setSending(true);
    setPendingText(content);
    setStreamText('');
    const attached = attachment;
    setAttachment(null);
    try {
      const id = threadId ?? (await createThread(token));
      if (!threadId) setThreadIds((current) => ({ ...current, [userId]: id }));
      await sendMessage(token, id, content, attached, (update) => {
        if (update.event === 'token') setStreamText((text) => text + update.text);
        else setStepText(STEP_LABELS[update.node] ?? null);
      });
      const next = await getThread(token, id);
      setThread(next);
      if (next.approvalId) setApprovalId(next.approvalId);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setSending(false);
      setPendingText(null);
      setStreamText('');
      setStepText(null);
    }
  };

  const handleDecision = async (decision: 'approve' | 'reject') => {
    if (!token || !detail || detail.decidableStep === null) return;
    setDeciding(true);
    setError(null);
    try {
      await decide(token, detail.approvalId, detail.decidableStep, decision);
      await Promise.all([refresh(), refreshDetail()]);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setDeciding(false);
    }
  };

  const startNewChat = () => {
    if (!userId) return;
    setThreadIds(({ [userId]: _removed, ...rest }) => rest);
    setThread(null);
    setApprovalId(null);
    setDetail(null);
    setError(null);
  };

  const useSample = async (file: string) => {
    setError(null);
    try {
      const response = await fetch(`/samples/${file}`);
      setAttachment(await fileToAttachment(await response.blob(), file));
      setDraft(PDF_EXAMPLE);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (file) setAttachment(await fileToAttachment(file, file.name));
  };

  const waiting = thread?.status === 'waiting_approval';
  const messages = thread?.messages ?? [];

  return (
    <div className="desk">
      <aside className="people" aria-label="사용자와 결재함">
        <h1>도장</h1>
        <p className="tagline">결재를 받아야만 일하는 AI 신입사원</p>

        <nav aria-label="역할 전환">
          <h2>누구로 접속할까요</h2>
          <ul>
            {users.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  aria-pressed={candidate.id === userId}
                  onClick={() => void selectUser(candidate.id)}
                >
                  <span>{candidate.name}</span>
                  <small>{candidate.department}</small>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section aria-label="결재함">
          <h2>결재함 {inbox.length > 0 && <span className="count">{inbox.length}</span>}</h2>
          {inbox.length === 0 ? (
            <p className="empty">처리할 결재가 없습니다.</p>
          ) : (
            <ul>
              {inbox.map((item) => (
                <li key={item.approvalId}>
                  <button
                    type="button"
                    aria-pressed={item.approvalId === approvalId}
                    onClick={() => setApprovalId(item.approvalId)}
                  >
                    <span>{item.vendorName}</span>
                    <small>
                      {item.requesterName}, {won(item.proposal.amountKrw)}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      <main className="chat">
        <header className="chat-head">
          <p>{user ? `${user.department} ${user.name}(${ROLE_LABELS[user.role] ?? user.role})` : '접속 중'}</p>
          <button type="button" className="quiet" onClick={startNewChat} disabled={!threadId || sending}>
            새 대화
          </button>
        </header>

        <div className="log" aria-live="polite">
          {messages.length === 0 && !pendingText && (
            <div className="welcome">
              <p>도장에게 재무 업무를 맡겨 보세요.</p>
              <button type="button" className="quiet" onClick={() => setDraft(EXAMPLE)}>
                {EXAMPLE}
              </button>
              <button type="button" className="quiet" onClick={() => void useSample('invoice-normal.pdf')}>
                정상 청구서 PDF로 요청
              </button>
              <button type="button" className="quiet" onClick={() => void useSample('invoice-attack.pdf')}>
                숨은 지시가 든 청구서 PDF로 요청
              </button>
            </div>
          )}
          {messages.map((message, index) => (
            <p key={index} className={`bubble ${message.role}`}>
              {message.content}
              {message.attachmentName && <small>첨부: {message.attachmentName}</small>}
            </p>
          ))}
          {pendingText && <p className="bubble user">{pendingText}</p>}
          {streamText && <p className="bubble assistant">{streamText}</p>}
          {stepText && <p className="step">{stepText}</p>}
          <div ref={logEnd} />
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {attachment && (
          <p className="attachment">
            첨부: {attachment.name}
            <button type="button" className="quiet" onClick={() => setAttachment(null)}>
              첨부 취소
            </button>
          </p>
        )}

        <form className="composer" onSubmit={(event) => void submit(event)}>
          <label className="file-button">
            PDF
            <input
              type="file"
              accept="application/pdf"
              className="sr-only"
              disabled={waiting || sending}
              onChange={(event) => {
                void pickFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          <label className="sr-only" htmlFor="message">
            메시지
          </label>
          <textarea
            id="message"
            rows={2}
            value={draft}
            maxLength={4000}
            disabled={waiting || sending || !token}
            placeholder={waiting ? '결재가 끝나면 이어서 입력할 수 있습니다.' : '업무를 입력하세요'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button type="submit" disabled={waiting || sending || !draft.trim()}>
            보내기
          </button>
        </form>
      </main>

      <aside className="document" aria-label="결재 문서">
        {detail ? (
          <ApprovalSheet detail={detail} busy={deciding} onDecide={(d) => void handleDecision(d)} />
        ) : (
          <div className="no-sheet">
            <p>결재 문서가 여기에 표시됩니다.</p>
            <p>지급을 요청하거나 결재함에서 건을 선택하세요.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
