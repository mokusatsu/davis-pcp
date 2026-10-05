import { readFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { store } from '../src/app/store';
import TgtPage from '../src/features/tgt/TgtPage';
import { touringAnalysisValues } from '../src/features/tgt/touringProjection';
const f = vi.hoisted(() => ({ data: null as any, control: null as any, canvas: null as any }));
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => f.data }));
vi.mock('../src/features/tgt/TgtCanvas', () => ({ TgtCanvas: (props: any) => { f.canvas = props; return <div data-testid="projection"/>; } }));
vi.mock('../src/features/tgt/TgtControlPanel', () => ({ TgtControlPanel: (props: any) => { f.control = props; return <div />; } }));
vi.mock('../src/features/tgt/ProjectionCircle', () => ({ ProjectionCircle: () => null }));
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <div>{children}</div> }));
afterEach(() => { cleanup(); f.control = null; f.canvas = null; });
const root = '../../backend/app/data/builtin_samples/';
const book = JSON.parse(readFileSync(new URL(root + 'kakegawa-citizen2022-adult600.codebook.json', import.meta.url), 'utf8'));
const lines = readFileSync(new URL(root + 'kakegawa-citizen2022-adult600.csv', import.meta.url), 'utf8').trim().split(/\r?\n/);
const names = lines[0].split(','), rows = lines.slice(1).map(line => line.split(','));
// This shipped numeric-only CSV has no quoted delimiters; fail on another shape.
if (rows.length !== 600 || names.length !== 84 || rows.some(r => r.length !== 84))
    throw Error('Unexpected CSV shape');
const raw = Object.fromEntries(names.map((name, j) => [name, rows.map(r => r[j] === '' ? null : Number(r[j]))]));
const items = ['問20_満足度_01', '問20_満足度_02', '問20_満足度_03'];
function mount(columns: any[], values: Record<string, unknown[]>, scope?: string[]) {
    const ids = Object.values(values)[0].map((_, i) => `ROW-${String(i + 1).padStart(6, '0')}`);
    const specs = columns.map(c => ({ label: c.name, categoryOrder: [], missingCodes: [], valueLabels: {}, isReversed: false, multiResponseGroup: null, ...c, columnId: c.name }));
    f.data = { rowIds: ids, rowIndex: new Map(ids.map((id, i) => [id, i])), columns: values,
        schema: specs.map(c => ({ name: c.name, columnId: c.name, semanticType: values[c.name].every(v => v == null || typeof v === 'number' || typeof v === 'bigint') ? 'numeric' : 'categorical' })),
        numeric: Object.fromEntries(Object.entries(values).map(([name, array]) => [name, Float64Array.from(array, v => v == null ? NaN : Number(v))])) };
    const base = store.getState(), initial: any = { ...base, selection: { ...base.selection, datasetId: 'qa-tour', allRowIds: ids, activeRowIds: scope ?? ids, selectedRowIds: [ids[2]] },
        globalVariables: { ...base.globalVariables, activeEntities: specs.map(c => ({ kind: 'column', columnId: c.columnId })) },
        codebook: { ...base.codebook, datasetId: 'qa-tour', schemaRevision: 1, columns: specs } };
    const actions: string[] = [];
    const local = configureStore({ reducer: (state = initial, action: any) => action.type === 'qa/book' ? { ...state, codebook: { ...state.codebook, columns: action.payload, schemaRevision: state.codebook.schemaRevision + 1 } } : state,
        middleware: get => get({ serializableCheck: false }).concat(() => next => action => { actions.push((action as { type: string }).type); return next(action); }) });
    const view = render(<Provider store={local}><MemoryRouter initialEntries={['/touring']}><TgtPage /></MemoryRouter></Provider>);
    return { ...view, local, ids, specs, actions, select: (chosen: string[]) => act(() => f.control.onColumnsChange(chosen)),
        edit: (updated: any[]) => act(() => { f.canvas = null; local.dispatch({ type: 'qa/book', payload: updated }); }) };
}
function z(values: number[][]) {
    const means = values[0].map((_, j) => values.reduce((s, r) => s + r[j], 0) / values.length);
    const sd = means.map((mean, j) => Math.sqrt(values.reduce((s, r) => s + (r[j] - mean) ** 2, 0) / (values.length - 1)));
    return values.map(r => r.map((v, j) => sd[j] ? (v - means[j]) / sd[j] : 0));
}
function equalMatrix(actual: number[][], expected: number[][]) {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((r, i) => r.forEach((v, j) => expect(actual[i][j]).toBeCloseTo(v, 11)));
}
it('uses role/scale candidates and leaves ordinal dimensions for explicit selection', () => {
    mount(book.columns, raw);
    expect(f.control.columns).toContain('年齢');
    expect(f.control.columns).toContain(items[0]);
    expect(f.control.columns).not.toContain('回答番号');
    expect(f.control.columns).not.toContain('性別');
    expect(f.control.selectedColumns).toEqual(book.columns.filter((c: any) => ['attribute', 'question'].includes(c.role) && ['interval', 'ratio'].includes(c.scaleType) && !c.multiResponseGroup).map((c: any) => c.name).slice(0, 6));
});
it('updates actual Kakegawa252 rows to exact200 on domain edit without changing source or selection', () => {
    const original = JSON.stringify(raw), v = mount(book.columns, raw);
    v.select(items);
    expect(f.canvas.rowIds).toHaveLength(252);
    v.edit(v.specs.map(c => items.includes(c.name) ? { ...c, categoryOrder: ['1', '2', '3'] } : c));
    const valid = rows.map((_, i) => i).filter(i => items.every(n => [1, 2, 3].includes(raw[n][i] as number)));
    expect(valid).toHaveLength(200);
    expect(f.canvas.rowIds).toEqual(valid.map(i => v.ids[i]));
    equalMatrix(f.canvas.dataMatrix, z(valid.map(i => items.map(n => raw[n][i] as number))));
    expect(v.local.getState().selection.selectedRowIds).toEqual([v.ids[2]]);
    expect(JSON.stringify(raw)).toBe(original);
    expect(v.actions.filter(type => /^(selection|globalVariables)\//.test(type))).toEqual([]);
});
it.each(['ordinal', 'interval'])('applies %s reversal/domain before standardization with reordered scope', scaleType => {
    const ids = rows.map((_, i) => `ROW-${String(i + 1).padStart(6, '0')}`).filter((_, i) => i % 3 === 0).reverse();
    const v = mount(book.columns, raw, ids);
    v.select(items);
    const order = scaleType === 'ordinal' ? ['3', '1', '2'] : ['1', '2', '3'];
    v.edit(v.specs.map(c => items.includes(c.name) ? { ...c, scaleType, categoryOrder: order, isReversed: c.name === items[0] } : c));
    const valid = ids.filter(id => items.every(n => [1, 2, 3].includes(raw[n][v.ids.indexOf(id)] as number)));
    expect(f.canvas.rowIds).toEqual(valid);
    equalMatrix(f.canvas.dataMatrix, z(valid.map(id => items.map((n, j) => { const x = raw[n][v.ids.indexOf(id)] as number; const score = scaleType === 'ordinal' ? order.indexOf(String(x)) + 1 : x; return j === 0 ? 4 - score : score; }))));
});
it('includes explicitly ordered string ordinals and preserves exact code identity', () => {
    const v = mount([{ name: 'X', role: 'question', scaleType: 'ordinal', categoryOrder: ['001', '1', 'last'] }, ...['Y', 'Z'].map(name => ({ name, role: 'question', scaleType: 'ratio' }))], { X: ['001', '1', 'last', '001'], Y: [1, 2, 4, 8], Z: [3, 4, 5, 9] });
    expect(f.control.columns).toContain('X');
    v.select(['X', 'Y', 'Z']);
    equalMatrix(f.canvas.dataMatrix, z([[1, 1, 3], [2, 2, 4], [3, 4, 5], [1, 8, 9]]));
});
it('keeps labels-only numeric domains open and true0 valid while excluding IDs, weights and MA', () => {
    const names = ['X', 'Y', 'Z', 'ID', 'weight', 'MA'];
    const values = Object.fromEntries(names.map(n => [n, [0, 1, 3]]));
    mount(names.map(name => ({ name, role: name === 'ID' ? 'id' : name === 'weight' ? 'weight' : 'question', scaleType: 'ratio', valueLabels: { '1': 'one' }, multiResponseGroup: name === 'MA' ? 'group' : null })), values);
    expect(f.control.columns).toEqual(['X', 'Y', 'Z']);
    expect(f.canvas.rowIds).toHaveLength(3);
    equalMatrix(f.canvas.dataMatrix, z([[0, 0, 0], [1, 1, 1], [3, 3, 3]]));
});
it('does not infer a new domain when every declared ordinal code is missing', () => {
    const v = mount(book.columns, raw);
    v.select(items);
    v.edit(v.specs.map(c => items.includes(c.name) ? { ...c, categoryOrder: ['0', '5'] } : c));
    expect(f.canvas).toBeNull();
    expect(v.getByText(/投影できる有効行がありません/)).toBeInTheDocument();
});
it('reverses a selected ordinal axis in place without replacing the projection basis', () => {
    const view = mount(book.columns, raw);
    view.select(items);
    const engine = f.canvas.engine;
    const before = f.canvas.dataMatrix.map((row: number[]) => [...row]);
    const ids = [...f.canvas.rowIds];
    view.edit(view.specs.map(c => c.name === items[0] ? { ...c, isReversed: true } : c));
    expect(f.canvas.engine).toBe(engine);
    expect(view.actions.filter(type => /^(selection|globalVariables)\//.test(type))).toEqual([]);
    expect(f.canvas.rowIds).toEqual(ids);
    equalMatrix(f.canvas.dataMatrix, before.map((row: number[]) => [-row[0], ...row.slice(1)]));
});
it('keeps labels-only ordinal ranks fixed over the full dataset when the scope is reordered', () => {
    const view = mount([{ name: 'X', role: 'question', scaleType: 'ordinal', valueLabels: { A: 'alpha' } },
        ...['Y', 'Z'].map(name => ({ name, role: 'question', scaleType: 'ratio' }))], { X: ['A', 'B', 'C', 'A'], Y: [1, 2, 4, 8], Z: [3, 4, 5, 9] }, ['ROW-000003', 'ROW-000002', 'ROW-000004']);
    view.select(['X', 'Y', 'Z']);
    expect(f.canvas.rowIds).toEqual(['ROW-000003', 'ROW-000002', 'ROW-000004']);
    equalMatrix(f.canvas.dataMatrix, z([[3, 4, 5], [2, 2, 4], [1, 8, 9]]));
});
it('refuses reversed numeric projection without fixed codebook bounds', () => {
    const view = mount(['X', 'Y', 'Z'].map(name => ({ name, role: 'question', scaleType: 'ratio', isReversed: name === 'X' })), { X: [1, 2, 3], Y: [2, 4, 8], Z: [3, 5, 9] });
    expect(f.canvas).toBeNull();
    expect(view.getByText(/逆転にはコードブックで固定の尺度範囲/)).toBeInTheDocument();
});
it('keeps reversed finite extreme numeric coordinates finite', () => {
    mount(['X', 'Y', 'Z'].map(name => ({ name, role: 'question', scaleType: 'ratio', isReversed: true,
        categoryOrder: [1e308, 1.2e308, 1.4e308].map(value => BigInt(value).toString()) })), { X: [1e308, 1.2e308, 1.4e308], Y: [1e308, 1.2e308, 1.4e308], Z: [1e308, 1.2e308, 1.4e308] });
    expect(f.canvas.rowIds).toHaveLength(3);
    equalMatrix(f.canvas.dataMatrix, [[1, 1, 1], [0, 0, 0], [-1, -1, -1]]);
});


it.each([
    [1e-7, '1e-07'], [1e-6, '1e-06'], [1e-5, '1e-05'], [1e-4, '0.0001'],
    [1e21, '1000000000000000000000'], [-0, '0'],
])('matches backend numeric code for %s with declared code %s', (value, code) => {
    const spec: any = { name: 'X', scaleType: 'interval', categoryOrder: [code], missingCodes: [], valueLabels: {} };
    expect(touringAnalysisValues(spec, [value]).values).toEqual([value]);
    expect(touringAnalysisValues({ ...spec, missingCodes: [code] }, [value]).values[0]).toBeNaN();
});

it('does not coerce numeric-equivalent literal strings into a declared code', () => {
    const spec: any = { name: 'X', scaleType: 'ordinal', categoryOrder: ['1e-07', '01', '1.0'], missingCodes: [], valueLabels: {} };
    expect(touringAnalysisValues(spec, [1e-7, '1e-7', '1e-07', '01', '1.0', '1']).values).toEqual([1, NaN, 1, 2, 3, NaN]);
    expect(touringAnalysisValues({ ...spec, categoryOrder: ['0.000001'] }, [1e-6]).values[0]).toBeNaN();
});

it('uses decimal numeric parsing rather than JavaScript hex/binary/coercion rules', () => {
    const spec: any = { name: 'X', scaleType: 'ratio', categoryOrder: [], missingCodes: [], valueLabels: {} };
    const values = touringAnalysisValues(spec, ['0x10', '0b10', '1_000', ' 1 ', [], [1], {}, '1.', '.1', '+1', '1e-07', 0]).values;
    expect(values).toEqual([NaN, NaN, NaN, NaN, NaN, NaN, NaN, 1, .1, 1, 1e-7, 0]);
});

it('handles real Arrow Int64 values without losing code identity or fit rows', () => {
    const integers = Object.fromEntries(Object.entries(raw).map(([name, values]) => [name, values.map(value => value === null ? null : BigInt(value))]));
    const view = mount(book.columns, integers);
    view.select(items);
    view.edit(view.specs.map(c => items.includes(c.name) ? { ...c, categoryOrder: ['1', '2', '3'] } : c));
    const valid = rows.map((_, i) => i).filter(i => items.every(name => [1, 2, 3].includes(raw[name][i] as number)));
    expect(f.canvas.rowIds).toEqual(valid.map(i => view.ids[i]));
    equalMatrix(f.canvas.dataMatrix, z(valid.map(i => items.map(name => raw[name][i] as number))));
});

it('preserves canonical Boolean ordinal codes and ordinary numeric Boolean scores', () => {
    const spec: any = { name: 'X', scaleType: 'ordinal', categoryOrder: ['False', 'True'], missingCodes: [], valueLabels: {} };
    expect(touringAnalysisValues(spec, [false, true, 'false', 'True']).values).toEqual([1, 2, NaN, 2]);
    expect(touringAnalysisValues({ ...spec, missingCodes: ['True'] }, [false, true]).values).toEqual([1, NaN]);
    expect(touringAnalysisValues({ ...spec, scaleType: 'ratio', categoryOrder: [] }, [false, true]).values).toEqual([0, 1]);
});

it('uses fixed reversed numeric bounds with backend float-string parsing', () => {
    const spec: any = { name: 'X', scaleType: 'interval', categoryOrder: ['1_000', ' 2000 ', '3000'], isReversed: true, missingCodes: [], valueLabels: {} };
    expect(touringAnalysisValues(spec, ['1_000', ' 2000 ', '3000']).values).toEqual([3000, 2000, 1000]);
});
