import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { writingInstructions, WRITING_MODES, WRITING_STYLES, WritingMode } from '../writing/WritingStyle';
import { newDraft } from '../writing/model';
import { DraftStore } from '../writing/DraftStore';

test('style preferences compose author input without mutating notes or using inactive custom text', () => {
    const legacy = { instructions: '이 예시는 그대로 남겨 줘.' };
    assert.match(writingInstructions(legacy), /했다\/이다체/);
    assert.equal(legacy.instructions, '이 예시는 그대로 남겨 줘.');
    const outputs = WRITING_STYLES.map(writingStyle => writingInstructions({ ...legacy, writingStyle, customStyle: '독자에게 질문하는 해요체' }));
    assert.equal(new Set(outputs).size, WRITING_STYLES.length);
    assert.ok(outputs.every(output => output.includes(legacy.instructions)));
    assert.ok(outputs.slice(0, -1).every(output => !output.includes('독자에게 질문하는')));
    assert.match(outputs.at(-1)!, /독자에게 질문하는 해요체/);
    assert.equal(writingInstructions({ instructions: '', writingStyle: 'custom', customStyle: '  ' }), writingInstructions({ instructions: '' }));
    assert.throws(() => writingInstructions({ instructions: 'a'.repeat(12000) }), /12,000/);
});

test('composition modes are independent of prose style and preserve the author request', () => {
    const preferences = { instructions: '예시는 두 개만.', writingStyle: 'custom' as const, customStyle: '짧은 해요체' };
    const outputs = WRITING_MODES.map(writingMode => writingInstructions({ ...preferences, writingMode }));
    assert.equal(new Set(outputs).size, 3);
    assert.ok(outputs.every(output => output.includes(preferences.instructions) && output.includes(preferences.customStyle)));
    assert.equal(writingInstructions(preferences), outputs[0]);
    assert.throws(() => writingInstructions({ instructions: '', writingMode: 'unknown' as WritingMode }));
});

test('draft storage restores selected mode, style and custom prose while legacy drafts keep defaults', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'psb-style-'));
    const store = new DraftStore(directory);
    try {
        const draft = newDraft({ id: 'style', filePath: '/workspace/style.c', language: 'c', startedAt: 1,
            lastModified: 1, requestLogs: [], snapshots: [{ timestamp: 1, content: 'int a=1;', hash: 'a' }] });
        assert.equal(draft.writingStyle, 'plain');
        assert.equal(draft.writingMode, 'evolution');
        draft.writingMode = 'algorithm';
        draft.writingStyle = 'custom'; draft.customStyle = '짧은 해요체로, 비유 없이.';
        await store.save(draft);
        const restored = (await store.read(draft.filePath))!;
        assert.equal(restored.writingStyle, 'custom');
        assert.equal(restored.writingMode, 'algorithm');
        assert.equal(restored.customStyle, draft.customStyle);
        assert.equal(writingInstructions(restored), writingInstructions(draft));
        delete restored.writingMode; delete restored.writingStyle; delete restored.customStyle;
        await store.save(restored);
        assert.match(writingInstructions((await store.read(draft.filePath))!), /했다\/이다체/);
        assert.equal(writingInstructions((await store.read(draft.filePath))!), writingInstructions({ instructions: '' }));
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
