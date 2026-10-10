// SPDX-License-Identifier: GPL-3.0-or-later
// A deliberately bounded, interpreted JSON Schema subset. No runtime code generation.
import { assert, isObject, boundedJSON, canonical } from './common.js';
const TYPES = new Set(['object','array','string','number','integer','boolean','null']);
const KEYS = new Set(['type','description','properties','required','additionalProperties','items','enum','anyOf',
  'minimum','maximum','exclusiveMinimum','exclusiveMaximum','minLength','maxLength','minItems','maxItems']);
export function checkSchema(raw) {
  const s = boundedJSON(raw, 128 * 1024); let count = 0, properties = 0;
  function visit(n, depth) {
    assert(isObject(n) && depth <= 12 && ++count <= 1000, 'SCHEMA_TOO_COMPLEX');
    assert(Object.keys(n).every(k => KEYS.has(k)), 'UNSUPPORTED_SCHEMA_KEYWORD');
    if (n.description !== undefined) assert(typeof n.description === 'string' && n.description.length <= 4000, 'INVALID_SCHEMA');
    if (n.anyOf !== undefined) {
      assert(!n.type && !n.enum && Object.keys(n).every(k => ['anyOf','description'].includes(k)), 'INVALID_SCHEMA');
      assert(Array.isArray(n.anyOf) && n.anyOf.length >= 1 && n.anyOf.length <= 64, 'INVALID_SCHEMA');
      n.anyOf.forEach(x => visit(x, depth + 1)); return;
    }
    const types = Array.isArray(n.type) ? n.type : [n.type];
    assert(types.length >= 1 && types.length <= 2 && new Set(types).size === types.length && types.every(t => TYPES.has(t)), 'INVALID_SCHEMA_TYPE');
    if (types.length === 2) assert(types.includes('null'), 'UNSUPPORTED_SCHEMA_UNION');
    const t = types.find(x => x !== 'null') ?? 'null';
    const permitted = new Set(['type','description','enum']);
    const extras = { object:['properties','required','additionalProperties'],array:['items','minItems','maxItems'],
      string:['minLength','maxLength'],number:['minimum','maximum','exclusiveMinimum','exclusiveMaximum'],integer:['minimum','maximum','exclusiveMinimum','exclusiveMaximum'] };
    (extras[t] || []).forEach(k => permitted.add(k));
    assert(Object.keys(n).every(k => permitted.has(k)), 'INVALID_SCHEMA_KEYWORD_TYPE');
    if (n.enum !== undefined) {
      assert(Array.isArray(n.enum) && n.enum.length >= 1 && n.enum.length <= 256, 'INVALID_SCHEMA_ENUM');
      assert(!types.includes('object') && !types.includes('array'), 'INVALID_SCHEMA_ENUM');
      assert(n.enum.every(v => types.some(type => matchesType(v, type))), 'INVALID_SCHEMA_ENUM');
      assert(new Set(n.enum.map(canonical)).size === n.enum.length, 'INVALID_SCHEMA_ENUM');
    }
    if (t === 'object') {
      assert(isObject(n.properties) && Array.isArray(n.required) && n.additionalProperties === false, 'CLOSED_OBJECT_REQUIRED');
      const keys = Object.keys(n.properties); properties += keys.length;
      assert(properties <= 1500 && keys.length <= 100, 'SCHEMA_TOO_COMPLEX');
      assert(keys.every(k => k.length <= 120 && !['__proto__','constructor','prototype'].includes(k)), 'UNSAFE_KEY');
      assert(n.required.length === keys.length && new Set(n.required).size === keys.length && keys.every(k => n.required.includes(k)), 'ALL_FIELDS_MUST_BE_REQUIRED');
      Object.values(n.properties).forEach(x => visit(x, depth + 1));
    }
    if (t === 'array') { assert(n.items !== undefined, 'INVALID_SCHEMA'); visit(n.items, depth + 1); }
    for (const k of ['minLength','maxLength','minItems','maxItems']) if (n[k] !== undefined)
      assert(Number.isInteger(n[k]) && n[k] >= 0 && n[k] <= 1000000, 'INVALID_SCHEMA_BOUND');
    for (const k of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum']) if (n[k] !== undefined)
      assert(typeof n[k] === 'number' && Number.isFinite(n[k]), 'INVALID_SCHEMA_BOUND');
    for (const [a,b] of [['minLength','maxLength'],['minItems','maxItems'],['minimum','maximum']])
      if (n[a] !== undefined && n[b] !== undefined) assert(n[a] <= n[b], 'INVALID_SCHEMA_BOUND');
  }
  visit(s, 0); return s;
}
function matchesType(v,t) {
  return t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'object' ? isObject(v)
    : t === 'integer' ? typeof v === 'number' && Number.isSafeInteger(v)
    : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === t;
}
export function validate(schema, raw) {
  const value = boundedJSON(raw); let cost = 0;
  function check(s,v) {
    if (++cost > 100000) return false;
    if (s.anyOf) return s.anyOf.some(branch => check(branch,v));
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some(t => matchesType(v,t))) return false;
    if (s.enum && !s.enum.some(x => canonical(x) === canonical(v))) return false;
    if (v === null) return true;
    if (isObject(v)) return Object.keys(v).every(k => Object.hasOwn(s.properties,k)) && s.required.every(k => Object.hasOwn(v,k)) && Object.keys(v).every(k => check(s.properties[k],v[k]));
    if (Array.isArray(v)) return (s.minItems === undefined || v.length >= s.minItems) && (s.maxItems === undefined || v.length <= s.maxItems) && v.every(x => check(s.items,x));
    if (typeof v === 'string') { const len = [...v].length; return (s.minLength === undefined || len >= s.minLength) && (s.maxLength === undefined || len <= s.maxLength); }
    if (typeof v === 'number') return (s.minimum === undefined || v >= s.minimum) && (s.maximum === undefined || v <= s.maximum) && (s.exclusiveMinimum === undefined || v > s.exclusiveMinimum) && (s.exclusiveMaximum === undefined || v < s.exclusiveMaximum);
    return true;
  }
  assert(check(schema,value), 'SCHEMA_VALIDATION_FAILED'); return value;
}
export function normalizeCommands(raw) {
  const cmds = boundedJSON(raw, 128 * 1024);
  assert(Array.isArray(cmds) && cmds.length >= 1 && cmds.length <= 40, 'INVALID_COMMANDS');
  const names = new Set();
  return cmds.map(c => {
    assert(isObject(c) && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(c.name) && !names.has(c.name), 'INVALID_COMMAND_NAME');
    names.add(c.name);
    assert(typeof c.description === 'string' && c.description.length <= 4000, 'INVALID_COMMAND_DESCRIPTION');
    assert(['read','write','external'].includes(c.effect), 'INVALID_COMMAND_EFFECT');
    assert(c.inputSchema?.type === 'object', 'COMMAND_ARGUMENTS_MUST_BE_OBJECT');
    return { name:c.name, description:c.description, effect:c.effect, inputSchema:checkSchema(c.inputSchema) };
  });
}
export function planSchema(commands) {
  const branches = commands.map(c => ({ type:'object',properties:{op:{type:'string',enum:[c.name],description:c.description},args:c.inputSchema},required:['op','args'],additionalProperties:false }));
  return checkSchema({type:'object',properties:{kind:{type:'string',enum:['commands','complete','clarify']},message:{type:'string',maxLength:4000},commands:{type:'array',items:{anyOf:branches},maxItems:12}},required:['kind','message','commands'],additionalProperties:false});
}
export function validatePlan(schema, raw) {
  const p = validate(schema, raw);
  assert(p.kind === 'commands' ? p.commands.length > 0 : p.commands.length === 0, 'INVALID_PLAN_KIND');
  return p;
}
