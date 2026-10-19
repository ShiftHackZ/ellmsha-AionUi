import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button, Tooltip } from '@arco-design/web-react';
import { Add, Branch, Cpu, Delete, User } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { RouterConfig } from '@/common/types/agent/routerTypes';
import { uuid } from '@/common/utils/utils';
import type { RouterOption } from './useRouter';
import RouterClassFields, { RouterTargetPicker, type RouterClassDraft } from './RouterNodeFields';
import styles from './AutoRouter.module.css';

type Point = { x: number; y: number };
type Connections = { paths: string[]; dots: Point[] };

/** Route each row through its free upper gap; wrapped rows share an outside gutter. */
function connect(parent: DOMRect, targets: DOMRect[], origin: DOMRect): Connections {
  if (!targets.length) return { paths: [], dots: [] };
  const rows: DOMRect[][] = [];
  for (const target of targets) {
    const row = rows.find((entries) => Math.abs(entries[0].top - target.top) < 2);
    if (row) row.push(target);
    else rows.push([target]);
  }
  rows.sort((a, b) => a[0].top - b[0].top);
  const source = { x: parent.left + parent.width / 2 - origin.left, y: parent.bottom - origin.top };
  const firstY = rows[0][0].top - origin.top - 16;
  const trunk = rows.length > 1 ? 8 : source.x;
  const paths = [`M ${source.x} ${source.y} V ${firstY} H ${trunk}`];
  const dots: Point[] = [{ x: source.x, y: firstY }];
  rows.forEach((row, index) => {
    const y = index === 0 ? firstY : row[0].top - origin.top - 16;
    const ends = row.map((target) => ({ x: target.left + target.width / 2 - origin.left, y: target.top - origin.top }));
    if (index) paths.push(`M ${trunk} ${firstY} V ${y}`);
    paths.push(
      `M ${Math.min(trunk, ...ends.map((end) => end.x))} ${y} H ${Math.max(trunk, ...ends.map((end) => end.x))}`
    );
    dots.push({ x: trunk, y });
    ends.forEach((end) => {
      paths.push(`M ${end.x} ${y} V ${end.y}`);
      dots.push({ x: end.x, y });
    });
  });
  return { paths, dots };
}

const RouterDiagram: React.FC<{
  config: RouterConfig;
  classes: RouterClassDraft[];
  options: RouterOption[];
  onChange: (config: RouterConfig) => void;
  onClassesChange: (classes: RouterClassDraft[]) => void;
}> = ({ config, classes, options, onChange, onClassesChange }) => {
  const { t } = useTranslation();
  const graph = useRef<HTMLElement>(null);
  const [connections, setConnections] = useState<Connections>({ paths: [], dots: [] });
  useLayoutEffect(() => {
    const element = graph.current;
    if (!element) return;
    const measure = () => {
      const root = element.querySelector<HTMLElement>('[data-router-node="root"]');
      const child = element.querySelector<HTMLElement>('[data-router-node="child"]');
      const classifier = element.querySelector<HTMLElement>('[data-router-node="classifier"]');
      if (!root || !child || !classifier) return;
      const origin = element.getBoundingClientRect();
      const upper = connect(
        root.getBoundingClientRect(),
        [child.getBoundingClientRect(), classifier.getBoundingClientRect()],
        origin
      );
      const lower = connect(
        classifier.getBoundingClientRect(),
        [...element.querySelectorAll<HTMLElement>('[data-router-node="class"]')].map((node) =>
          node.getBoundingClientRect()
        ),
        origin
      );
      setConnections({ paths: [...upper.paths, ...lower.paths], dots: [...upper.dots, ...lower.dots] });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.querySelectorAll('[data-router-node]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [classes, config.mode, options]);
  const card = (
    node: 'root' | 'child' | 'classifier',
    name: string,
    icon: React.ReactNode,
    children: React.ReactNode
  ) => (
    <section className={styles.node} aria-label={name} data-router-node={node}>
      <h3 className={styles.nodeTitle}>
        {icon}
        {name}
      </h3>
      {children}
    </section>
  );
  const model = (role: 'root' | 'child' | 'classifier') => (
    <RouterTargetPicker
      role={role}
      target={config[`${role}_target`]}
      options={options}
      localOnly={config.local_only}
      active={role !== 'classifier' || classes.length > 0}
      onChange={(target) => onChange({ ...config, [`${role}_target`]: target })}
    />
  );
  const automatic = <p className={styles.nodeDetail}>{t('settings.autoRouter.graph.automatic')}</p>;
  return (
    <section ref={graph} aria-label={t('settings.autoRouter.graph.title')} className={styles.diagram}>
      <svg className={styles.connections} aria-hidden focusable='false'>
        {connections.paths.map((path, index) => (
          <path key={index} d={path} />
        ))}
        {connections.dots.map((point, index) => (
          <circle key={index} cx={point.x} cy={point.y} r={3} />
        ))}
      </svg>
      <div className={styles.root}>
        {card(
          'root',
          t('settings.autoRouter.graph.root'),
          <User />,
          config.mode === 'auto' ? automatic : model('root')
        )}
      </div>
      <div className={styles.branches}>
        {card(
          'child',
          t('settings.autoRouter.graph.defaultChild'),
          <Cpu />,
          <>
            {config.mode === 'manual' ? model('child') : automatic}
            <p className={styles.caption}>{t('settings.autoRouter.graph.defaultBranch')}</p>
          </>
        )}
        {card(
          'classifier',
          t('settings.autoRouter.graph.classifier'),
          <Branch />,
          <>
            {model('classifier')}
            <p className={styles.caption}>
              {t(
                classes.length ? 'settings.autoRouter.graph.customBranch' : 'settings.autoRouter.graph.unusedClassifier'
              )}
            </p>
          </>
        )}
      </div>
      {classes.length > 0 && (
        <div className={styles.classes} aria-label={t('settings.autoRouter.graph.classes')}>
          {classes.map((entry) => (
            <section
              key={entry.id}
              className={styles.node}
              aria-label={entry.name || t('settings.autoRouter.graph.addClass')}
              data-router-node='class'
            >
              <div className='flex items-center justify-between gap-8px'>
                <h3 className={styles.nodeTitle}>
                  <Cpu />
                  {entry.name || t('settings.autoRouter.graph.addClass')}
                </h3>
                <Tooltip content={t('common.delete')}>
                  <Button
                    type='text'
                    size='mini'
                    status='danger'
                    aria-label={t('common.delete')}
                    icon={<Delete size={16} />}
                    onClick={() => onClassesChange(classes.filter((item) => item.id !== entry.id))}
                  />
                </Tooltip>
              </div>
              <RouterClassFields
                value={entry}
                options={options}
                onChange={(next) => onClassesChange(classes.map((item) => (item.id === entry.id ? next : item)))}
              />
            </section>
          ))}
        </div>
      )}
      <div className={styles.actions}>
        {!classes.length && <p className={styles.caption}>{t('settings.autoRouter.graph.noClasses')}</p>}
        <Button
          type='dashed'
          size='small'
          icon={<Add />}
          onClick={() => onClassesChange([...classes, { id: `class-${uuid(32)}`, name: '', description: '' }])}
          disabled={classes.length >= 32}
        >
          {t('settings.autoRouter.graph.addClass')}
        </Button>
      </div>
    </section>
  );
};
export default RouterDiagram;
