// SPDX-License-Identifier: GPL-3.0-or-later
// Application-independent optional interaction contract. Business rules stay in page handlers.
import { assert, isObject, boundedJSON, canonical } from './common.js';
export const WORKFLOW_PROTOCOL = 'page-workflow/1';
export const WORKFLOW_ROLES = Object.freeze(['prepare','resume','run','cancel']);
export const FORM_LIMITS = Object.freeze({ questions:32, optionsPerQuestion:256, optionsTotal:1024, textLength:4000, bytes:128*1024 });
const STATES = new Set(['needs_input','ready','completed','invalidated','cancelled']);
const TYPES = new Set(['single','multi','text','confirmation']);
function id(value, code='INVALID_WORKFLOW_ID') {
  assert(typeof value==='string' && value.length>0 && value.length<=200 && !['__proto__','constructor','prototype'].includes(value),code);
  return value;
}
function text(value, max, code='INVALID_QUESTION') { assert(typeof value==='string' && [...value].length<=max,code); }
export function safeView(value) {
  return typeof value==='string' && value.length<=256 && /^\/(?!\/)[A-Za-z0-9_./-]*$/.test(value) && !value.split('/').includes('..');
}
export function validateQuestions(raw) {
  const questions=boundedJSON(raw,FORM_LIMITS.bytes);
  assert(Array.isArray(questions)&&questions.length>=1&&questions.length<=FORM_LIMITS.questions,'INVALID_QUESTIONS');
  const ids=new Set();let total=0;
  for(const q of questions) {
    assert(isObject(q),'INVALID_QUESTION');id(q.id,'INVALID_QUESTION_ID');assert(!ids.has(q.id),'DUPLICATE_QUESTION_ID');ids.add(q.id);
    assert(TYPES.has(q.type),'UNSUPPORTED_QUESTION_TYPE');text(q.prompt,4000);assert(q.prompt.trim().length>0&&typeof q.required==='boolean','INVALID_QUESTION');
    if(q.requiresPageAction!==undefined)assert(typeof q.requiresPageAction==='boolean','INVALID_QUESTION');
    if(q.requiresPageAction) {
      assert(q.type==='confirmation'&&isObject(q.pageAction)&&safeView(q.pageAction.view),'INVALID_PAGE_ACTION');
      text(q.pageAction.instruction,4000,'INVALID_PAGE_ACTION');
    } else assert(q.pageAction===undefined,'INVALID_PAGE_ACTION');
    if(q.type==='single'||q.type==='multi') {
      assert(Array.isArray(q.options)&&q.options.length>0&&q.options.length<=FORM_LIMITS.optionsPerQuestion,'INVALID_OPTIONS');
      total+=q.options.length;assert(total<=FORM_LIMITS.optionsTotal,'FORM_TOO_LARGE');const values=new Set();
      for(const o of q.options){assert(isObject(o),'INVALID_OPTION');id(o.value,'INVALID_OPTION');text(o.label,1000,'INVALID_OPTION');assert(!values.has(o.value),'DUPLICATE_OPTION_ID');values.add(o.value);}
      if(q.type==='multi') {
        assert(Number.isInteger(q.minItems)&&Number.isInteger(q.maxItems)&&q.minItems>=0&&q.maxItems>=q.minItems&&q.maxItems<=q.options.length,'INVALID_MULTI_BOUNDS');
      } else assert(q.minItems===undefined&&q.maxItems===undefined,'INVALID_QUESTION');
      assert(q.maxLength===undefined,'INVALID_QUESTION');
    } else {
      assert(q.options===undefined&&q.minItems===undefined&&q.maxItems===undefined,'INVALID_QUESTION');
      if(q.type==='text')assert(Number.isInteger(q.maxLength)&&q.maxLength>0&&q.maxLength<=FORM_LIMITS.textLength,'INVALID_TEXT_BOUND');
      else assert(q.maxLength===undefined,'INVALID_QUESTION');
    }
  }
  return questions;
}
export function validateWorkflow(raw) {
  const w=boundedJSON(raw,FORM_LIMITS.bytes);
  assert(isObject(w)&&w.workflow===WORKFLOW_PROTOCOL,'UNSUPPORTED_WORKFLOW_VERSION');
  assert(STATES.has(w.status),'UNSUPPORTED_WORKFLOW_STATUS');id(w.requestId);
  assert(Number.isSafeInteger(w.draftRevision)&&w.draftRevision>=0,'INVALID_DRAFT_REVISION');
  assert(Number.isSafeInteger(w.expiresAt)&&w.expiresAt>0,'INVALID_WORKFLOW_EXPIRY');
  // Optional method is opaque application metadata, never an extension dispatch selector.
  if(w.method!==undefined){text(w.method,80,'INVALID_WORKFLOW_METHOD');assert(w.method.length>0,'INVALID_WORKFLOW_METHOD');}
  if(w.running!==undefined)assert(typeof w.running==='boolean','INVALID_WORKFLOW_RUNNING');
  for(const role of ['resume','run','cancel'])if(w[role]!==undefined) {
    assert(isObject(w[role])&&Object.keys(w[role]).every(k=>k==='command')&&validCommandName(w[role].command),'UNSUPPORTED_WORKFLOW_COMMAND');
  }
  if(w.message!==undefined)text(w.message,4000,'INVALID_WORKFLOW_MESSAGE');
  if(w.preview!==undefined)assert(isObject(w.preview),'INVALID_WORKFLOW_PREVIEW');
  if(w.status==='needs_input') {
    w.questions=validateQuestions(w.questions);
    assert(isObject(w.resume),'UNSUPPORTED_WORKFLOW_COMMAND');
  }
  if(w.status==='ready')assert(isObject(w.run),'UNSUPPORTED_WORKFLOW_COMMAND');
  if(w.status==='completed') {
    id(w.resultId,'INVALID_RESULT_REFERENCE');
    if(w.view!==undefined)assert(safeView(w.view),'INVALID_RESULT_VIEW');
  }
  return w;
}
function validCommandName(name) {return typeof name==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name);}
export function commandRole(command,definitions) {return definitions.find(d=>d.name===(typeof command==='string'?command:command.op))?.workflowRole||null;}
export function workflowCommand(workflow,role,definitions) {
  const name=workflow?.[role]?.command;
  assert(validCommandName(name)&&definitions.some(d=>d.name===name&&d.workflowRole===role),'UNSUPPORTED_WORKFLOW_COMMAND');
  return name;
}
export function pendingWorkflow(snapshot) {
  const raw=snapshot.workflow;
  return raw===null||raw===undefined?null:validateWorkflow(raw);
}
export function workflowFromExecution(result,definitions) {
  const matches=[];
  for(const r of result.results) {
    // Ordinary command output is opaque data. Do not interpret arbitrary "workflow" fields.
    if(r.status==='completed'&&commandRole(r.op,definitions))matches.push(validateWorkflow(r.result));
  }
  assert(matches.length<=1,'AMBIGUOUS_WORKFLOW_RESULT');
  return matches[0]||null;
}
/** Stable IDs, not order or labels alone. Reordering options does not change their meaning. */
export function questionIdentity(q) {
  return canonical({...q,...(q.options?{options:[...q.options].sort((a,b)=>a.value.localeCompare(b.value))}: {})});
}
export function workflowIdentity(w) {
  return canonical({...w,...(w.questions?{questions:[...w.questions].map(q=>({id:q.id,identity:questionIdentity(q)})).sort((a,b)=>a.id.localeCompare(b.id))}: {})});
}
export function preserveInputs(previousQuestions,nextQuestions,values={}) {
  const result=Object.create(null);
  for(const q of nextQuestions) {
    const old=previousQuestions.find(x=>x.id===q.id);
    if(old&&questionIdentity(old)===questionIdentity(q)&&Object.hasOwn(values,q.id))result[q.id]=boundedJSON(values[q.id]);
  }
  return result;
}
export function answerErrors(questions,raw) {
  const errors=Object.create(null);let answers;
  try {answers=boundedJSON(raw,FORM_LIMITS.bytes);} catch {return {errors:{_form:'回答が大きすぎるか、形式が不正です。'},answers:[]};}
  if(!Array.isArray(answers)||answers.length>FORM_LIMITS.questions)return {errors:{_form:'回答の形式が不正です。'},answers:[]};
  const seen=new Set();
  for(const a of answers) {
    if(!isObject(a)||!Object.hasOwn(a,'value')||Object.keys(a).some(k=>!['questionId','value'].includes(k))) {errors._form='回答の形式が不正です。';continue;}
    const q=questions.find(x=>x.id===a.questionId);
    if(!q){errors._form='不明な質問への回答は送信できません。';continue;}
    if(seen.has(q.id)){errors[q.id]='同じ質問への回答が重複しています。';continue;}seen.add(q.id);
    if(q.requiresPageAction){errors[q.id]='この確認は対象ページで行い、「ページで確認後に再確認」を押してください。';continue;}
    const v=a.value;
    if(q.type==='single' && (typeof v!=='string'||!q.options.some(o=>o.value===v)))errors[q.id]='候補から選択してください。';
    if(q.type==='multi') {
      if(!Array.isArray(v)||v.some(x=>typeof x!=='string'||!q.options.some(o=>o.value===x))||new Set(v).size!==v.length)errors[q.id]='候補から重複なく選択してください。';
      else if(v.length<q.minItems||v.length>q.maxItems)errors[q.id]=`${q.minItems}〜${q.maxItems}件を選択してください。`;
    }
    if(q.type==='text'&&(typeof v!=='string'||[...v].length>q.maxLength||(q.required&&!v.trim())))errors[q.id]=`必要な回答を${q.maxLength}文字以内で入力してください。`;
    if(q.type==='confirmation'&&typeof v!=='boolean')errors[q.id]='「はい」または「いいえ」を明示的に選択してください。';
  }
  for(const q of questions)if(q.required&&!seen.has(q.id))errors[q.id]=q.requiresPageAction?'対象ページでの確認が必要です。':'この質問に回答してください。';
  return {errors,answers};
}
export function validateAnswers(questions,raw) {
  const {answers,errors}=answerErrors(validateQuestions(questions),raw);
  assert(Object.keys(errors).length===0,'INVALID_USER_ANSWERS');return answers;
}
/** Declared lifecycle operations are standalone; no name/prefix is reserved by the extension. */
export function assertWorkflowPlan(plan,definitions,{model=false}={}) {
  const lifecycle=plan.commands.filter(c=>commandRole(c,definitions));
  if(!lifecycle.length)return;
  assert(plan.commands.length===1,'WORKFLOW_PLAN_MUST_BE_SINGLE');
  if(model)assert(commandRole(lifecycle[0],definitions)==='prepare','MODEL_CANNOT_RESUME_WORKFLOW');
  // Do not infer consent from parameter names or interpret application-specific booleans.
  // A host must keep user-only values out of model-eligible commands and validate them itself.
}
/** Page-side transport guard. The host must also check business semantics and durable idempotency. */
export function assertWorkflowPrecondition(command,snapshot,clock=()=>Date.now()) {
  const role=commandRole(command,snapshot.commands);
  if(!role||role==='prepare')return;
  const w=pendingWorkflow(snapshot);assert(w,'NO_PENDING_WORKFLOW');
  assert(command.args.requestId===w.requestId&&command.args.draftRevision===w.draftRevision,'STALE_DRAFT');
  if(role==='run'&&w.status==='completed')return;
  if(role==='run')assert(w.status==='ready','WORKFLOW_NOT_READY');
  if(role==='resume')assert(w.status==='needs_input','WORKFLOW_NOT_WAITING');
  assert(workflowCommand(w,role,snapshot.commands)===command.op,'UNSUPPORTED_WORKFLOW_COMMAND');
  if(role==='cancel')return; // return an existing result; never execute again
  assert(w.expiresAt>clock(),'WORKFLOW_EXPIRED');
  assert(w.running!==true,'WORKFLOW_RUNNING');
  if(role==='resume') {
    assert(w.status==='needs_input','WORKFLOW_NOT_WAITING');validateAnswers(w.questions,command.args.answers);
  } else assert(w.status==='ready','WORKFLOW_NOT_READY');
}
