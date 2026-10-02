/* TypeScript companion to predict.js; identical binary64 runtime.
 * Dependency-free DAVIS regularized regression runtime v1.
 * model.json is data, never executable source. Works in Node and browsers.
 * The schema rule placeholder is replaced with JSON data by the exporter.
 */
const MODEL_RULE = /*__MODEL_RULE__*/;
const DEFAULT_COLUMN_MAPPING = /*__COLUMN_MAPPING__*/;
const SAFE_INTEGER = 9007199254740991;
const DECIMAL = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const own = (o: any, k: any) => Object.prototype.hasOwnProperty.call(o, k);
const object = (v: any): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const finite = (v: any) => typeof v === "number" && Number.isFinite(v);
const fail = (path: any, message: any): never => { throw new Error(`Invalid portable model at ${path}: ${message}`); };
const categoryKey = (c: any) => JSON.stringify([c.kind, c.code]);
const equal = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v: any, i: number) => equal(v, b[i]));
  if (object(a) && object(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k: any) => own(b, k) && equal(a[k], b[k]));
  return false;
};
function validUnicode(s: any) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (++i >= s.length) return false;
      const d = s.charCodeAt(i);
      if (d < 0xdc00 || d > 0xdfff) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function jsonValue(value: any, path: any = "model", seen: Set<unknown> | null = null) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { if (!validUnicode(value)) fail(path, "unpaired Unicode surrogate"); return; }
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(path, "number must be finite float64"); return; }
  if (Array.isArray(value) || object(value)) {
    seen = seen || new Set();
    if (seen.has(value)) fail(path, "circular data is not JSON");
    seen.add(value);
    if (Array.isArray(value)) { for (const [i, v] of value.entries()) jsonValue(v, `${path}[${i}]`, seen); }
    else { for (const k of Object.keys(value)) { jsonValue(k, path, seen); jsonValue(value[k], `${path}.${k}`, seen); } }
    seen.delete(value); return;
  }
  fail(path, "expected JSON data");
}
function check(value: any, rule: any, path: any = "model") {
  if (object(rule)) {
    if (!object(value) || Object.keys(value).length !== Object.keys(rule).length || Object.keys(rule).some((k: any) => !own(value, k))) fail(path, "missing, extra or invalid object fields");
    for (const k of Object.keys(rule)) check(value[k], rule[k], `${path}.${k}`);
  } else if (Array.isArray(rule)) {
    const [op, argument] = rule;
    if (op === "nullable") { if (value !== null) check(value, argument, path); }
    else if (op === "enum") { if (!argument.some((v: any) => v === value)) fail(path, "unsupported value/version"); }
    else if (op === "optional_object") {
      if (!object(value) || Object.keys(value).some(k => !own(argument, k))) fail(path, "unexpected diagnostic fields");
      for (const k of Object.keys(value)) check(value[k], argument[k], `${path}.${k}`);
    }
    else if (op === "list") {
      if (!Array.isArray(value)) fail(path, "expected array");
      value.forEach((v: any, i: number) => check(v, argument, `${path}[${i}]`));
    }
  } else {
    let ok = false;
    if (rule === "string" || rule === "nonempty_string") ok = typeof value === "string" && (rule === "string" || value.length > 0);
    else if (rule === "boolean") ok = typeof value === "boolean";
    else if (rule === "json_object") ok = object(value);
    else if (["number", "positive", "nonnegative", "positive_integer", "nonnegative_integer"].includes(rule)) {
      ok = finite(value);
      if (ok && rule.startsWith("positive")) ok = value > 0;
      if (ok && rule.startsWith("nonnegative")) ok = value >= 0;
      if (ok && rule.endsWith("integer")) ok = Number.isSafeInteger(value);
    }
    if (!ok) fail(path, `expected ${rule}`);
  }
}
function unique(values: any, path: any) { if (values.length !== new Set(values).size) fail(path, "duplicates are not allowed"); }
function validCategory(c: any, path: any) { if ((c.kind === "value") !== (c.code !== null)) fail(path, "value needs a string code; missing kinds need null"); }
const utf8 = new TextEncoder();
function unicodeCompare(a: any, b: any) {
  const aa = utf8.encode(a), bb = utf8.encode(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
}
function canonicalBytes(value: any) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  function push(bytes: any) { chunks.push(bytes); length += bytes.length; }
  function ascii(s: any) { push(utf8.encode(s)); }
  function walk(v: any) {
    if (v === null) { ascii("n"); return; }
    if (typeof v === "boolean") { ascii(v ? "t" : "f"); return; }
    if (typeof v === "number") {
      ascii("d"); const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, v === 0 ? 0 : v, false); push(bytes); return;
    }
    if (typeof v === "string") { const b = utf8.encode(v); ascii(`s${b.length}:`); push(b); return; }
    if (Array.isArray(v)) { ascii(`a${v.length}:`); v.forEach(walk); return; }
    const keys = Object.keys(v).sort(unicodeCompare); ascii(`o${keys.length}:`);
    for (const key of keys) { walk(key); walk(v[key]); }
  }
  walk(value);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
/* FIPS 180-4 SHA-256, synchronous standard JavaScript only (no crypto package). */
function sha256(bytes: any) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(size); padded.set(bytes); padded[bytes.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(size - 8, Math.floor(bytes.length / 0x20000000), false);
  view.setUint32(size - 4, (bytes.length * 8) >>> 0, false);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const W = new Uint32Array(64);
  for (let offset = 0; offset < size; offset += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(offset + 4 * t, false);
    for (let t = 16; t < 64; t++) {
      const x = W[t - 15], y = W[t - 2];
      const s0 = rotr(x,7) ^ rotr(x,18) ^ (x >>> 3), s1 = rotr(y,17) ^ rotr(y,19) ^ (y >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25), ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22), maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h=g;g=f;f=e;e=(d+temp1)>>>0;d=c;c=b;b=a;a=(temp1+temp2)>>>0;
    }
    [a,b,c,d,e,f,g,h].forEach((v: any,i: number) => { H[i] = (H[i] + v) >>> 0; });
  }
  return H.map((v: any) => v.toString(16).padStart(8,"0")).join("");
}
function contentHash(model: any) {
  const copy = Object.assign(Object.create(null), model);
  copy.identity = Object.assign(Object.create(null), model.identity);
  delete copy.identity.contentHash;
  return "sha256:" + sha256(canonicalBytes(copy));
}
function _runtime_validate_model(model: any, verify_hash: any = true) {
  jsonValue(model); check(model, MODEL_RULE);
  const training = model.training, rho = training.l1Ratio;
  if ((training.algorithm === "ridge" && rho !== 0) || (training.algorithm === "lasso" && rho !== 1) || (training.algorithm === "elasticnet" && !(rho > 0 && rho < 1))) fail("training.l1Ratio", "algorithm and ratio disagree");
  if (!training.convergence.converged) fail("training.convergence", "unconverged models cannot predict");
  const inputs = model.inputs, byId = new Map<any, any>(inputs.map((s: any) => [s.columnId, s]));
  unique(inputs.map((s: any) => s.columnId), "inputs.columnId");
  for (const spec of inputs) {
    const path = "inputs." + spec.columnId;
    for (const field of ["missingCodes","notApplicableCodes","ordinalOrder"]) unique(spec[field], path + "." + field);
    if (spec.notApplicableCodes.some((c: any) => !spec.missingCodes.includes(c))) fail(path,"not-applicable codes must be a subset of missing codes");
    if (spec.declaredCategories !== null) unique(spec.declaredCategories,path+".declaredCategories");
    unique(spec.observedCategories.map(categoryKey),path+".observedCategories");
    for (const c of spec.observedCategories) {
      validCategory(c,path);
      if (c.kind === "value" && [...spec.missingCodes,...spec.notApplicableCodes].includes(c.code)) fail(path,"a missing code cannot be an observed value");
    }
    if (spec.kind === "ordinal" && !spec.ordinalOrder.length) fail(path,"ordinal input requires frozen order");
    if (spec.kind !== "ordinal" && (spec.ordinalOrder.length || spec.ordinalReversed)) fail(path,"only ordinal inputs can have an order/reversal");
    if ((spec.trainingMin === null) !== (spec.trainingMax === null)) fail(path,"range endpoints must both be present or null");
    if (spec.trainingMin !== null && spec.trainingMin > spec.trainingMax) fail(path,"reversed range");
  }
  const features = model.features, coefficients = model.linearModel.coefficients;
  if (features.length !== coefficients.length || features.length !== model.display.coefficients.length) fail("features","feature, coefficient and display lengths disagree");
  unique(features.map((f: any) => f.designColumnId),"features.designColumnId");
  const used = new Map<any, any>(inputs.map((s: any) => [s.columnId, []]));
  features.forEach((feature: any,i: number) => {
    const path = `features[${i}]`, spec = byId.get(feature.inputColumnId);
    if (!spec) fail(path,"unknown inputColumnId");
    const expected = ({numeric:"identity",ordinal:"ordered_rank",categorical:"one_hot"} as Record<string, string>)[spec.kind];
    if (feature.operation !== expected) fail(path,"operation does not match input kind");
    const category = feature.category;
    if (expected === "one_hot") {
      if (category === null) fail(path,"one_hot requires category");
      validCategory(category,path);
      if (!spec.observedCategories.map(categoryKey).includes(categoryKey(category))) fail(path,"one_hot must refer to an observed category");
    } else if (category !== null) fail(path,"noncategorical feature cannot have a category");
    if (!training.intercept && feature.offset !== 0) fail(path,"no-intercept model cannot center features");
    used.get(spec.columnId).push(feature);
    const display = model.display.coefficients[i];
    if (display.designColumnId !== feature.designColumnId || display.columnId !== spec.columnId || display.kind !== spec.kind || !equal(display.category,category) || display.exactZero !== (coefficients[i] === 0)) fail("display.coefficients","display identity disagrees with execution");
    for (const [field,reason] of [["estimate","estimateReason"],["standardizedEstimate","standardizedReason"]]) if (display[field] === null && !display[reason]) fail("display.coefficients","null estimates require a reason");
  });
  for (const spec of inputs) {
    if (spec.kind === "categorical") {
      const actual = used.get(spec.columnId).map((f: any) => categoryKey(f.category)), expected = spec.observedCategories.map(categoryKey);
      if (new Set(actual).size !== actual.length || actual.length !== expected.length || !expected.length || expected.some((c: any) => !actual.includes(c))) fail("features","categorical input requires exactly the full observed one-hot basis");
    } else if (used.get(spec.columnId).length !== 1) fail("features","numeric/ordinal input requires exactly one feature");
  }
  const display = model.display;
  if (display.intercept.estimate === null && !display.intercept.reason) fail("display.intercept","null estimate requires a reason");
  unique(display.categoryReferences.map((r: any) => r.columnId),"display.categoryReferences");
  for (const r of display.categoryReferences) {
    const spec = byId.get(r.columnId);
    if (!spec || spec.kind !== "categorical") fail("display.categoryReferences","reference must name a categorical input");
    if (!equal(r.levels,spec.observedCategories) || !r.levels.map(categoryKey).includes(categoryKey(r.reference))) fail("display.categoryReferences","reference levels disagree with frozen input");
  }
  if (verify_hash && (!/^sha256:[0-9a-f]{64}$/.test(model.identity.contentHash) || model.identity.contentHash !== contentHash(model))) fail("identity.contentHash","integrity check failed");
}
function _runtime_seal_model(model: any) {
  jsonValue(model);
  const copy = JSON.parse(JSON.stringify(model));
  if (object(copy) && object(copy.identity)) copy.identity.contentHash = "";
  _runtime_validate_model(copy,false); copy.identity.contentHash = contentHash(copy); return copy;
}
function mappingFor(model: any, mapping: any) {
  if (mapping === null || mapping === undefined) mapping = {};
  if (!object(mapping)) throw new Error("column_mapping must map input columnId to record key");
  jsonValue(mapping, "column_mapping");
  const ids = new Set(model.inputs.map((s: any) => s.columnId));
  if (Object.keys(mapping).some((k: any) => !ids.has(k) || typeof mapping[k] !== "string")) throw new Error("column_mapping contains unknown columnId or non-string key");
  const result = new Map<any, any>(model.inputs.map((s: any) => [s.columnId, own(mapping,s.columnId) ? mapping[s.columnId] : s.key]));
  if (new Set(result.values()).size !== result.size) throw new Error("column_mapping reuses an input key; explicitly map each input to a distinct key");
  return result;
}
function result(model: any, status: any, warnings: any, prediction: any = null) { return {prediction,status,warnings,modelVersion:model.identity.modelVersion}; }
function code(value: any) {
  if (typeof value === "string") return validUnicode(value) ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}
function normalize(spec: any, raw: any, policy: any) {
  if (spec.kind === "numeric") {
    if (raw === null) return [null,"missing_value"];
    let value;
    if (typeof raw === "string") {
      raw = raw.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g,"");
      if (!raw || spec.missingCodes.includes(raw) || spec.notApplicableCodes.includes(raw)) return [null,"missing_value"];
      if (!DECIMAL.test(raw)) return [null,"invalid_type"];
      value = Number(raw);
      if (value === 0 && /[1-9]/.test(raw.split(/[eE]/, 1)[0])) return [null,"numeric_range"];
    } else if (typeof raw === "number") {
      value = raw;
    } else return [null,"invalid_type"];
    if (!Number.isFinite(value)) return [null,"numeric_range"];
    for (const sentinel of spec.missingCodes) {
      const text = sentinel.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, "");
      if (DECIMAL.test(text)) {
        const missing = Number(text), underflow = missing === 0 && /[1-9]/.test(text.split(/[eE]/, 1)[0]);
        if (Number.isFinite(missing) && !underflow && value === missing) return [null,"missing_value"];
      }
    }
    return [value,null];
  }
  let c = raw === null ? null : code(raw);
  if (raw !== null && c === null) return [null,"invalid_type"];
  let kind = "value";
  if (spec.notApplicableCodes.includes(c)) kind = "not_applicable";
  else if (raw === null || spec.missingCodes.includes(c)) kind = "missing";
  if (kind !== "value") {
    if (spec.kind === "ordinal" || policy === "exclude") return [null,"missing_value"];
    if (policy === "include_missing") kind = "missing";
    c = null;
  }
  if (spec.kind === "ordinal") {
    if (!spec.ordinalOrder.includes(c)) return [null,spec.declaredCategories !== null && spec.declaredCategories.includes(c) ? "unobserved_category" : "unknown_category"];
    const rank = spec.ordinalOrder.indexOf(c) + 1;
    return [spec.ordinalReversed ? spec.ordinalOrder.length + 1 - rank : rank,null];
  }
  const level = categoryKey({kind,code:c});
  if (!spec.observedCategories.map(categoryKey).includes(level)) {
    return [null,kind !== "value" || (spec.declaredCategories !== null && spec.declaredCategories.includes(c)) ? "unobserved_category" : "unknown_category"];
  }
  return [level,null];
}
function predictValidated(model: any, record: any, mapping: any) {
  const warnings: PredictionWarning[] = [];
  if (!object(record)) return result(model,"invalid_type",warnings);
  const values = new Map<any, any>(), policy = model.preprocessing.categoricalMissingPolicy;
  for (const spec of model.inputs) {
    const cid = spec.columnId, key = mapping.get(cid);
    if (!own(record,key)) return result(model,"missing_field",[...warnings,{code:"missing_field",columnId:cid}]);
    const [value,error] = normalize(spec,record[key],policy);
    if (error) return result(model,error,[...warnings,{code:error,columnId:cid}]);
    values.set(cid,value);
    if (spec.kind !== "categorical" && spec.trainingMin !== null && !(value >= spec.trainingMin && value <= spec.trainingMax)) warnings.push({code:"extrapolation",columnId:cid});
  }
  const lm = model.linearModel;
  let total = lm.intercept;
  for (let i = 0; i < model.features.length; i++) {
    const feature = model.features[i];
    let value = values.get(feature.inputColumnId);
    if (feature.operation === "one_hot") value = value === categoryKey(feature.category) ? 1 : 0;
    const centered = value - feature.offset, scaled = centered / feature.scale, term = lm.coefficients[i] * scaled;
    total = total + term;
    const underflow = (centered !== 0 && scaled === 0) || (lm.coefficients[i] !== 0 && scaled !== 0 && term === 0);
    if (underflow || ![centered,scaled,term,total].every(Number.isFinite)) return result(model,"numeric_range",[...warnings,{code:"numeric_range",columnId:feature.inputColumnId}]);
  }
  const transformed = lm.targetScale * total, prediction = lm.targetOffset + transformed;
  if ((total !== 0 && transformed === 0) || !Number.isFinite(transformed) || !Number.isFinite(prediction)) return result(model,"numeric_range",[...warnings,{code:"numeric_range"}]);
  return result(model,"ok",warnings,prediction === 0 ? 0 : prediction);
}
function _runtime_predict_record(model: any, record: any, column_mapping: any = DEFAULT_COLUMN_MAPPING) {
  _runtime_validate_model(model); return predictValidated(model,record,mappingFor(model,column_mapping));
}
function _runtime_predict_batch(model: any, records: any, column_mapping: any = DEFAULT_COLUMN_MAPPING) {
  _runtime_validate_model(model); const mapping = mappingFor(model,column_mapping);
  if (!Array.isArray(records)) throw new Error("records must be a JSON array");
  return records.map((record: any) => predictValidated(model,record,mapping));
}

export type ColumnMapping = Record<string, string> | null;
export type PredictionStatus = "ok" | "missing_field" | "missing_value" | "invalid_type" |
  "unknown_category" | "unobserved_category" | "out_of_domain" | "numeric_range";
export interface PredictionWarning { code: string; columnId?: string; message?: string; }
export interface PredictionResult { prediction: number | null; status: PredictionStatus;
  warnings: PredictionWarning[]; modelVersion: "1"; }
/** JSON model data is deliberately unknown until validate_model checks it. */
export type PortableModel = Record<string, unknown>;
export function validate_model(model: PortableModel, verify_hash = true): void {
  _runtime_validate_model(model, verify_hash);
}
export function seal_model(model: PortableModel): PortableModel {
  return _runtime_seal_model(model);
}
export function predict_record(model: PortableModel, record: unknown,
                               column_mapping: ColumnMapping = DEFAULT_COLUMN_MAPPING): PredictionResult {
  return _runtime_predict_record(model, record, column_mapping);
}
export function predict_batch(model: PortableModel, records: unknown[],
                              column_mapping: ColumnMapping = DEFAULT_COLUMN_MAPPING): PredictionResult[] {
  return _runtime_predict_batch(model, records, column_mapping);
}
