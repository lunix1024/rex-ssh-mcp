import {
  createPrompt,
  isBackspaceKey,
  isDownKey,
  isEnterKey,
  isNumberKey,
  isUpKey,
  makeTheme,
  useKeypress,
  usePagination,
  usePrefix,
  useState,
} from '@inquirer/core';

export type PromptResult<T> = { kind: 'value'; value: T } | { kind: 'back' };

export interface NumberedChoice<T> {
  name: string;
  value: T;
  description?: string;
}

interface NumberedSelectConfig<T> {
  message: string;
  choices: readonly NumberedChoice<T>[];
  defaultIndex?: number;
  pageSize?: number;
  escapeLabel?: '返回' | '退出';
}

interface TextPromptConfig {
  message: string;
  default?: string;
  mask?: boolean | string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
}

/** 将输入的十进制编号转换为零基下标；返回 undefined 表示尚未形成有效选择。 */
export function resolveNumberedIndex(input: string, choiceCount: number): number | undefined {
  if (!/^\d+$/.test(input)) return undefined;
  const index = Number(input) - 1;
  return Number.isSafeInteger(index) && index >= 0 && index < choiceCount ? index : undefined;
}

/** Esc 在所有自定义提示器中使用同一判定，避免不同页面的返回键行为不一致。 */
function isEscapeKey(key: { name: string }): boolean {
  return key.name === 'escape';
}

const numberedSelectPrompt = createPrompt<PromptResult<unknown>, NumberedSelectConfig<unknown>>((config, done) => {
  if (config.choices.length === 0) throw new Error('Numbered select requires at least one choice.');
  const theme = makeTheme({});
  const [status, setStatus] = useState<'idle' | 'done'>('idle');
  const [active, setActive] = useState(Math.min(Math.max(config.defaultIndex ?? 0, 0), config.choices.length - 1));
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const [returned, setReturned] = useState(false);
  const prefix = usePrefix({ status, theme });

  useKeypress((key, rl) => {
    if (status !== 'idle') return;
    if (isEscapeKey(key)) {
      setReturned(true);
      setStatus('done');
      done({ kind: 'back' });
      return;
    }
    if (isEnterKey(key)) {
      const selected = typed ? resolveNumberedIndex(typed, config.choices.length) : active;
      if (selected === undefined) { setError('请输入列表中存在的编号。'); return; }
      setActive(selected);
      setStatus('done');
      done({ kind: 'value', value: config.choices[selected]!.value });
      return;
    }
    if (isUpKey(key) || isDownKey(key)) {
      rl.clearLine(0);
      setTyped('');
      setError(undefined);
      const offset = isUpKey(key) ? -1 : 1;
      setActive((active + offset + config.choices.length) % config.choices.length);
      return;
    }
    if (isNumberKey(key) || isBackspaceKey(key)) {
      const input = rl.line;
      setTyped(input);
      setError(undefined);
      const selected = resolveNumberedIndex(input, config.choices.length);
      if (selected !== undefined) setActive(selected);
      return;
    }
    // 菜单只接受数字；清除意外输入，避免字母残留导致随后输入编号无法匹配。
    rl.clearLine(0);
    setTyped('');
    setError('请输入编号，或按 Esc 返回。');
  });

  const selectedChoice = config.choices[active]!;
  const page = usePagination({
    items: config.choices,
    active,
    pageSize: config.pageSize ?? 10,
    loop: true,
    renderItem: ({ item, index, isActive }) => {
      const line = `${isActive ? '>' : ' '} ${index + 1}. ${item.name}`;
      return isActive ? theme.style.highlight(line) : line;
    },
  });
  const message = theme.style.message(config.message, status);
  if (returned) return `${prefix} ${message} ${theme.style.answer(config.escapeLabel === '退出' ? '已退出' : '已返回')}`;
  if (status === 'done') return `${prefix} ${message} ${theme.style.answer(selectedChoice.name)}`;
  const detail = selectedChoice.description ? `\n${theme.style.help(selectedChoice.description)}` : '';
  const errorLine = error ? `\n${theme.style.error(error)}` : '';
  return `${prefix} ${message}${typed ? ` ${typed}` : ''}\n${page}${detail}${errorLine}\n${theme.style.help(`输入编号定位 · ↑↓ 选择 · Enter 确认 · Esc ${config.escapeLabel ?? '返回'}`)}`;
});

/** 类型安全包装底层 unknown prompt，调用方得到与 choices.value 对应的精确类型。 */
export function numberedSelect<T>(config: NumberedSelectConfig<T>): Promise<PromptResult<T>> {
  return numberedSelectPrompt(config as NumberedSelectConfig<unknown>) as Promise<PromptResult<T>>;
}

const textPrompt = createPrompt<PromptResult<string>, TextPromptConfig>((config, done) => {
  const theme = makeTheme({});
  const [status, setStatus] = useState<'idle' | 'loading' | 'done'>('idle');
  const [value, setValue] = useState('');
  const [defaultValue, setDefaultValue] = useState(config.default);
  const [error, setError] = useState<string>();
  const [returned, setReturned] = useState(false);
  const prefix = usePrefix({ status, theme });

  useKeypress(async (key, rl) => {
    if (status !== 'idle') return;
    if (isEscapeKey(key)) {
      setReturned(true);
      setValue('');
      setStatus('done');
      done({ kind: 'back' });
      return;
    }
    if (isEnterKey(key)) {
      const answer = value || defaultValue || '';
      setStatus('loading');
      const validation = config.validate ? await config.validate(answer) : true;
      if (validation === true) {
        setValue(answer);
        setStatus('done');
        done({ kind: 'value', value: answer });
      } else {
        setError(typeof validation === 'string' ? validation : '请输入有效内容。');
        setStatus('idle');
      }
      return;
    }
    if (isBackspaceKey(key) && !rl.line) setDefaultValue(undefined);
    setValue(rl.line);
    setError(undefined);
  });

  const message = theme.style.message(config.message, status);
  if (returned) return `${prefix} ${message} ${theme.style.answer('已返回')}`;
  const masked = config.mask
    ? (typeof config.mask === 'string' ? config.mask : '*').repeat(value.length)
    : value;
  const answer = status === 'done' ? theme.style.answer(masked) : masked;
  const defaultText = !value && defaultValue && status === 'idle' ? theme.style.defaultAnswer(defaultValue) : '';
  const errorLine = error ? `\n${theme.style.error(error)}` : '';
  return `${prefix} ${message}${defaultText ? ` ${defaultText}` : ''}${answer ? ` ${answer}` : ''}${errorLine}\n${theme.style.help('Enter 确认 · Esc 返回')}`;
});

export function cancellableInput(config: Omit<TextPromptConfig, 'mask'>): Promise<PromptResult<string>> {
  return textPrompt(config);
}

export function cancellablePassword(config: Omit<TextPromptConfig, 'default' | 'mask'>): Promise<PromptResult<string>> {
  return textPrompt({ ...config, mask: '*' });
}
