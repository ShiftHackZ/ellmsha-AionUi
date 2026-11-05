import { ipcBridge } from '@/common';
import type { AgentQuestion } from '@/common/types/platform/acpTypes';
import { Button, Card, Checkbox, Input, Radio } from '@arco-design/web-react';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './PermissionRequestPanel.module.css';

type Reply = { choices: string[]; text: string };
const empty: Reply = { choices: [], text: '' };

export default function AgentQuestionForm({
  conversationId,
  msgId,
  callId,
  questions,
}: {
  conversationId: string;
  msgId: string;
  callId: string;
  questions: AgentQuestion[];
}) {
  const { t } = useTranslation();
  const [replies, setReplies] = useState(
    () =>
      new Map<string, Reply>(
        questions.map((q) => {
          const defaults = q.defaultLabels ?? [];
          return [
            q.id,
            {
              choices: defaults.filter((v) => q.options.some((o) => o.label === v)),
              text: defaults.find((v) => !q.options.some((o) => o.label === v)) ?? '',
            },
          ];
        })
      )
  );
  const [state, setState] = useState<'open' | 'sending' | 'answered' | 'dismissed' | 'error'>('open');
  const locked = useRef(false);
  const answers = questions.map((q) => {
    const { choices, text } = replies.get(q.id) ?? empty;
    return { question: q.id, labels: [...new Set([...choices, ...(text.trim() ? [text] : [])])] };
  });
  const canSend =
    answers.length > 0 &&
    answers.every((a, index) => questions[index].optional || questions[index].allowEmpty || a.labels.length > 0);
  const elicitation = callId.startsWith('elicit:');
  const send = async (response: 'submit' | 'reject' | 'cancel') => {
    const dismiss = response !== 'submit';
    if (locked.current || (!dismiss && !canSend)) return;
    locked.current = true;
    setState('sending');
    try {
      await ipcBridge.conversation.confirmation.confirm.invoke({
        conversation_id: conversationId,
        call_id: callId,
        msg_id: msgId,
        data: dismiss ? { value: response } : { answers },
        always_allow: false,
      });
      setReplies(new Map());
      setState(dismiss ? 'dismissed' : 'answered');
    } catch {
      locked.current = false;
      setState('error');
    }
  };
  if (state === 'answered' || state === 'dismissed')
    return (
      <p role='status'>{t(state === 'answered' ? 'messages.questions.answered' : 'messages.questions.dismissed')}</p>
    );
  return (
    <Card bordered={false} className={styles.card}>
      <form
        className={styles.panel}
        aria-busy={state === 'sending'}
        onSubmit={(e) => {
          e.preventDefault();
          void send('submit');
        }}
      >
        {questions.map((q) => {
          const reply = replies.get(q.id) ?? empty;
          const update = (value: Reply) => setReplies((prior) => new Map(prior).set(q.id, value));
          const Choice = q.multiSelect ? Checkbox : Radio;
          const options = q.options.map(({ label, description }) => (
            <Choice key={label} value={label} className='lt-sm:!min-h-44px'>
              <span className='inline-flex flex-col align-middle leading-5 break-words'>
                {label}
                {description && <span className='text-12px text-t-secondary'>{description}</span>}
              </span>
            </Choice>
          ));
          return (
            <fieldset className={styles.optionsFieldset} key={q.id} disabled={state === 'sending'}>
              <legend className={styles.title}>
                {q.question}
                {q.optional && <> {t('common.optional')}</>}
              </legend>
              {q.header && q.header !== q.question && <span className={styles.description}>{q.header}</span>}
              <div className='flex flex-col gap-6px mt-4px'>
                {q.options.length > 0 &&
                  (q.multiSelect ? (
                    <Checkbox.Group
                      direction='vertical'
                      value={reply.choices}
                      disabled={state === 'sending'}
                      onChange={(choices: string[]) => update({ ...reply, choices })}
                    >
                      {options}
                    </Checkbox.Group>
                  ) : (
                    <Radio.Group
                      direction='vertical'
                      name={`${callId}/${q.id}`}
                      disabled={state === 'sending'}
                      value={reply.choices[0] ?? null}
                      onChange={(value: string) => update({ choices: [value], text: '' })}
                    >
                      {options}
                    </Radio.Group>
                  ))}
                {(q.isOther || q.options.length === 0) && (
                  <Input
                    type={q.isSecret ? 'password' : 'text'}
                    autoComplete='off'
                    aria-label={q.options.length ? t('messages.questions.other') : q.question}
                    placeholder={q.options.length ? t('messages.questions.other') : undefined}
                    value={reply.text}
                    disabled={state === 'sending'}
                    onChange={(text) => update({ choices: !q.multiSelect && text ? [] : reply.choices, text })}
                  />
                )}
              </div>
              {q.optional && (reply.choices.length > 0 || reply.text) && (
                <Button size='mini' disabled={state === 'sending'} onClick={() => update(empty)}>
                  {t('common.clear')}
                </Button>
              )}
            </fieldset>
          );
        })}
        {state === 'error' && <p role='alert'>{t('messages.questions.failed')}</p>}
        <div className='flex gap-8px'>
          <Button
            type='primary'
            htmlType='submit'
            className='lt-sm:!h-44px'
            loading={state === 'sending'}
            disabled={!canSend || state === 'sending'}
          >
            {t('messages.questions.submit')}
          </Button>
          {elicitation && (
            <Button className='lt-sm:!h-44px' disabled={state === 'sending'} onClick={() => void send('reject')}>
              {t('messages.questions.decline')}
            </Button>
          )}
          <Button
            className='lt-sm:!h-44px'
            disabled={state === 'sending'}
            onClick={() => void send(elicitation ? 'cancel' : 'reject')}
          >
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
