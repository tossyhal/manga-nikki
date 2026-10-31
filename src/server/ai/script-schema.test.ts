import { describe, expect, it } from 'vitest';
import sample from '../../../docs/contracts/university-festival.script.example.json';
import { scriptSchema } from './script-schema';

describe('脚本JSONの検証', () => {
  it('大学祭のサンプルを受け付ける', () => {
    expect(scriptSchema.safeParse(sample).success).toBe(true);
  });

  it('3コマ、番号の重複、逆順を拒否する', () => {
    for (const panels of [
      sample.panels.slice(0, 3),
      sample.panels.map((panel) => ({ ...panel, index: 1 })),
      [...sample.panels].reverse(),
    ]) {
      expect(scriptSchema.safeParse({ ...sample, panels }).success).toBe(false);
    }
  });

  it('未知の項目、項目欠落、文字列以外を拒否する', () => {
    expect(scriptSchema.safeParse({ ...sample, extra: true }).success).toBe(false);
    expect(scriptSchema.safeParse({ title: sample.title }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...sample, title: 123 }).success).toBe(false);
    const changed = structuredClone(sample);
    Object.assign(changed.panels[0]!, { extra: true });
    expect(scriptSchema.safeParse(changed).success).toBe(false);
  });

  it('文字数の境界をUnicodeコードポイントで検証する', () => {
    const valid = structuredClone(sample);
    valid.title = '😀'.repeat(40);
    valid.panels[0]!.scene = 'あ'.repeat(250);
    valid.panels[0]!.caption = 'あ'.repeat(70);
    valid.panels[0]!.dialogue = '';
    expect(scriptSchema.safeParse(valid).success).toBe(true);
    expect(scriptSchema.safeParse({ ...valid, title: 'あ'.repeat(41) }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...valid, title: '' }).success).toBe(false);
    for (const [field, value] of [
      ['scene', ''],
      ['scene', 'あ'.repeat(251)],
      ['caption', 'あ'.repeat(71)],
      ['dialogue', 'あ'.repeat(71)],
    ] as const) {
      const invalid = structuredClone(valid);
      invalid.panels[0]![field] = value;
      expect(scriptSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
