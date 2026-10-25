'use strict';
// Presentation-only localization: campaign IDs, values and saved state stay original.
(function(){
 const KEY='arc-mission-control-language-v1';
 const choices=[
  {code:'en',name:'English',flag:'us'},
  {code:'es',name:'Español',flag:'es'},
  {code:'fr',name:'Français',flag:'fr'},
  {code:'de',name:'Deutsch',flag:'de'},
  {code:'pt-BR',name:'Português (Brasil)',flag:'br'},
  {code:'zh-Hans',name:'简体中文',flag:'cn'},
  {code:'ar',name:'العربية',flag:'sa'}
 ];
 const $=s=>document.querySelector(s),cache=new Map(),texts=new WeakMap(),attributes=new WeakMap();
 let language='en',exact=new Map(),patterns=[],fragments=null,queued=false,sequence=0;
 const normalize=s=>String(s).replace(/\s+/g,' ').trim();
 const escapeRegex=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 function compile(pack){
  exact=new Map();patterns=[];fragments=null;
  if(!pack)return;
  const plain=[];
  for(const {s,t} of pack.entries){
   if(!s.includes('{')){exact.set(normalize(s),t);if(s.length>=3&&s.length<=120&&/[A-Za-z]/.test(s))plain.push(s);continue;}
   const ids=[],tokens=s.split(/(\{\d+\})/g);
   const source=tokens.map(token=>{const m=token.match(/^\{(\d+)\}$/);if(m){ids.push(m[1]);return '(.+?)';}return escapeRegex(token);}).join('');
   patterns.push({regex:new RegExp('^'+source+'$','u'),ids,target:t,length:s.replace(/\{\d+\}/g,'').length});
  }
  patterns.sort((a,b)=>b.length-a.length);
  plain.sort((a,b)=>b.length-a.length);
  if(plain.length)fragments=new RegExp('(?<![\\p{L}\\p{N}_])(?:'+plain.map(escapeRegex).join('|')+')(?![\\p{L}\\p{N}_])','gu');
 }
 function translate(source){
  if(language==='en')return source;
  const key=normalize(source);let result=exact.get(key);
  if(result===undefined){
   for(const p of patterns){const match=key.match(p.regex);if(!match)continue;const values={};p.ids.forEach((id,i)=>values[id]=match[i+1]);result=p.target.replace(/\{(\d+)\}/g,(_,id)=>values[id]===undefined?'{'+id+'}':translate(values[id]));break;}
  }
  if(result===undefined&&fragments)result=key.replace(fragments,part=>exact.get(part)??part);
  if(result===undefined||result===key)return source;
  return (source.match(/^\s*/)?.[0]||'')+result+(source.match(/\s*$/)?.[0]||'');
 }
 function skip(el){return !el||!!el.closest('[data-no-translate],[translate="no"],script,style,code,pre,textarea,#language-label');}
 function apply(){
  queued=false;observer.disconnect();if(typeof document==='undefined'||!document.body)return;
  try{
   const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
   while((node=walker.nextNode())){
    if(skip(node.parentElement)||!normalize(node.data))continue;
    const old=texts.get(node);const source=old&&node.data===old.last?old.source:node.data;
    const next=translate(source);texts.set(node,{source,last:next});if(node.data!==next)node.data=next;
   }
   for(const el of document.querySelectorAll('[title],[aria-label],[placeholder]')){
    if(skip(el))continue;const records=attributes.get(el)||{};
    for(const name of ['title','aria-label','placeholder']){
     if(!el.hasAttribute(name))continue;const current=el.getAttribute(name),old=records[name];
     const source=old&&current===old.last?old.source:current,next=translate(source);
     records[name]={source,last:next};if(current!==next)el.setAttribute(name,next);
    }
    attributes.set(el,records);
   }
  }finally{observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['title','aria-label','placeholder']});}
 }
 function schedule(){if(queued||typeof document==='undefined'||!document.body)return;queued=true;queueMicrotask(apply);}
 const observer=new MutationObserver(schedule);
 function updatePicker(){
  const selected=choices.find(c=>c.code===language);
  $('#language-label').textContent=selected.name;
  $('#language-button-flag').src='flags/'+selected.flag+'.svg';
  document.querySelectorAll('[data-language]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.language===language)));
 }
 async function choose(code,close=false){
  if(!choices.some(c=>c.code===code))code='en';const token=++sequence;
  $('#language-status').textContent=code==='en'?'':'Loading language…';
  try{
   let pack=null;
   if(code!=='en'){
    if(!cache.has(code)){
     const next=globalThis.ARCOffline.locales[code];if(next.locale!==code||!Array.isArray(next.entries)||next.entries.some(e=>typeof e.s!=='string'||typeof e.t!=='string'))throw Error('Invalid language');cache.set(code,next);
    }
    pack=cache.get(code);
   }
   if(token!==sequence)return;
   language=code;compile(pack);document.documentElement.lang=code;document.documentElement.dir=code==='ar'?'rtl':'ltr';
   try{localStorage.setItem(KEY,code);}catch{}
   $('#language-status').textContent='';updatePicker();apply();if(close)$('#language-dialog').close();
  }catch{if(token===sequence)$('#language-status').textContent='Unable to load this language. Please try again.';}
 }
 const options=$('#language-options');
 options.innerHTML=choices.map(c=>`<button type="button" class="language-option" data-language="${c.code}" lang="${c.code}" aria-pressed="${c.code==='en'}"><img class="language-flag" src="flags/${c.flag}.svg" width="20" height="14" alt="" aria-hidden="true"><span>${c.name}</span></button>`).join('');
 document.querySelectorAll('[data-language]').forEach(el=>el.onclick=()=>void choose(el.dataset.language,true));
 $('#language-button').onclick=()=>{$('#language-status').textContent='';updatePicker();$('#language-dialog').showModal();};
 $('#language-close').onclick=()=>$('#language-dialog').close();
 $('#language-dialog').onclose=()=>$('#language-button').focus();
 $('#language-dialog').onclick=e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.currentTarget.close();};
 window.arcLanguage={choose:code=>choose(code),current:()=>language,translate};
 updatePicker();apply();let saved='en';try{saved=localStorage.getItem(KEY)||'en';}catch{}if(saved!=='en')void choose(saved);
})();
