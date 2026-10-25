'use strict';
const KEY='arc-mission-control-offline-v1';let storageKey=KEY,cloudReady=true;let data,by,view='next',map='all',search='',filter='all',selectedRaid=null,toastTimer;let state={completed:[],objectives:{},materials:{},raids:[],inventoryVersion:3,questDeductions:{}};const $=s=>document.querySelector(s);const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const recommendable=q=>!!q&&q.raidEnabled!==false;const campaignQuests=()=>data.quests.filter(recommendable);const campaignDone=()=>campaignQuests().filter(q=>isDone(q.id)).length;const isDone=id=>state.completed.includes(id);const unlocked=q=>recommendable(q)&&q.prerequisites.every(isDone);const status=q=>!recommendable(q)?'paused':isDone(q.id)?'done':unlocked(q)?'ready':'locked';const objectiveDone=(q,i)=>isDone(q.id)||!!state.objectives[q.id]?.includes(i);const anyMap=q=>q.maps.includes('any');
let planner,planCache,routeWorker,routeRequest=0,routeBusy=false,workerUnavailable=false;
const getPlanner=()=>planner??=ARCPlanner.create(data);
const routeKey=()=>JSON.stringify([storageKey,state.completed,state.objectives,state.activeDeployment,state.deploymentCount,state.raids,state.lastMap,state.rewardOptOut]);
function savedRoute(suffix=':route-v2'){try{return JSON.parse(localStorage.getItem(storageKey+suffix))}catch{return null}}
function rememberRoute(plan){
 if(plan.remaining)return;
 const compact=p=>p.steps.map(r=>({map:r.map,number:r.number,quests:r.quests}));
 try{
  localStorage.setItem(storageKey+':route-v2',JSON.stringify(compact(plan)));
  if(!state.completed.length&&Object.values(state.objectives).every(a=>!a.length)){
   const p=getPlanner(),fresh={completed:[],objectives:{},raids:[]};
   const candidate=p.replay(fresh,null,plan.steps),old=p.replay(fresh,null,savedRoute(':start-route-v1'));
   const best=p.better(old,candidate);if(best)localStorage.setItem(storageKey+':start-route-v1',JSON.stringify(compact(best)));
  }
 }catch{}
}
function stopRouteSearch(){routeWorker?.terminate();routeWorker=null;routeBusy=false;routeRequest++;}
function improveRoute(key,plan){
 stopRouteSearch();if(typeof Worker==='undefined'||workerUnavailable)return;
 const token=routeRequest,owner=storageKey,locked=state.activeDeployment||plan.steps[0];
 try{
  const worker=routeWorker=new Worker(offlineWorkerURL());routeBusy=true;
  worker.onmessage=e=>{
   if(token!==routeRequest||owner!==storageKey||key!==routeKey())return;
   if(e.data.error){workerUnavailable=true;stopRouteSearch();render();return;}
   const p=getPlanner(),candidate=p.replay(state,locked,e.data.plan?.steps);
   const best=p.better(planCache,candidate);
   if(best&&best!==planCache){planCache={...best,key,owner,rewards:p.allocations(state,best)};rememberRoute(best);}
   routeBusy=!e.data.final;
   if(e.data.final){worker.terminate();routeWorker=null;}
   const focused=document.activeElement,id=focused?.id,position=focused?.selectionStart;
   render();if(id){const el=document.getElementById?.(id);el?.focus();if(position!=null&&el?.setSelectionRange)el.setSelectionRange(position,position);}
  };
  worker.onerror=()=>{if(token!==routeRequest)return;workerUnavailable=true;stopRouteSearch();render();};
  worker.postMessage({data,saved:JSON.parse(JSON.stringify(state)),current:locked,prior:plan.steps});
 }catch{workerUnavailable=true;stopRouteSearch();}
}
function routePlan(){
 const key=routeKey();
 if(planCache?.key!==key){
  const p=getPlanner();let best=null;
  // Revalidate every cached route against current objectives and unlocks.
  // Keep the starting route separate so progress cannot overwrite it.
  for(const path of [planCache?.owner===storageKey?planCache.steps:null,savedRoute(),savedRoute(':start-route-v1'),globalThis.ARCSeed])best=p.better(best,p.replay(state,state.activeDeployment,path));
  // Without a worker, a short search on this thread stands in for the background one.
  const fallback=typeof Worker==='undefined'||workerUnavailable?p.search(state,state.activeDeployment,{prior:best?.steps,timeLimit:1500,shortRuns:3}):p.quickForecast(state,state.activeDeployment);best=p.better(best,fallback);
  planCache={...best,key,owner:storageKey,rewards:p.allocations(state,best)};rememberRoute(best);improveRoute(key,best);
 }
 return planCache;
}
function raidsRemaining(){
 const plan=routePlan();if(plan.remaining)return null;
 if(plan.raidCount===undefined){
  const planner=getPlanner();let progress=planner.snapshot(state),count=0;
  for(const step of plan.steps){
   if(step.quests.some(id=>planner.ready(by[id],progress)&&planner.work(by[id],step.map,progress).indices.length))count++;
   progress=planner.simulate(progress,step).state;
  }
  plan.raidCount=count;
 }
 return plan.raidCount;
}
function updateRaidEstimate(){
 const count=raidsRemaining();
 $('#side-caption').textContent=count===0&&campaignDone()<campaignQuests().length?'Raid objectives complete. Turn in remaining quests.':'Assumes planned objectives and turn-ins.';
}
const routeAllowed=id=>recommendable(by[id])&&(isDone(id)||getPlanner().stageAllowed(by[id],getPlanner().snapshot(state)));
const briefQuests=r=>r.quests.filter(routeAllowed);
const remainingRaid=r=>r.quests.filter(id=>routeAllowed(id)&&!isDone(id));
function nextRaid(){return state.activeDeployment||routePlan().steps[0]}
function settleDeployment(){
 const a=state.activeDeployment;
 if(a){a.quests=a.quests.filter(id=>routeAllowed(id)&&(isDone(id)||anyMap(by[id])||by[id].maps.includes(a.map)));if(!a.quests.length)delete state.activeDeployment;}
 if(a&&a.quests.some(id=>!isDone(id)&&!unlocked(by[id])))delete state.activeDeployment;
}
function retainCurrentBrief(){
 settleDeployment();if(state.activeDeployment)return;
 const r=nextRaid();if(r)state.activeDeployment={number:r.number,map:r.map,quests:[...r.quests]};
}
const questItemQty=(q,name)=>q.requiredItems.filter(i=>i.name===name).reduce((n,i)=>n+i.qty,0);
const available=name=>state.materials[name]||0;
const remainingUses=m=>m.quests.filter(q=>recommendable(by[q.id])&&!isDone(q.id));
const remainingTotal=m=>remainingUses(m).reduce((n,q)=>n+q.qty,0);
const activeMaterials=()=>data.materials.filter(m=>remainingUses(m).length);
function notice(s){$('#toast').textContent=s;$('#toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').style.display='none',3200)}
const structuredCloneSafe=s=>JSON.parse(JSON.stringify(s));
// Quest objectives are rebuilt from the game's quest data from time to time.
// Saves record which numbering they use; move older checks to the same
// objectives in the current lists (checks on removed objectives are dropped).
function migrateObjectives(objectives,version){
 const current=data.objectiveVersion||0;
 if(!Number.isInteger(version)||version<0||version>current)throw Error('Unsupported progress format');
 if(version===current)return objectives;
 const moves=data.objectiveMigrations?.[version]||{},out={};
 for(const [id,a] of Object.entries(objectives))out[id]=moves[id]&&Array.isArray(a)?[...new Set(a.map(i=>moves[id][i]??-1).filter(i=>i>=0))]:a;
 return out;
}
function validState(s){
 if(!s||!Array.isArray(s.completed)||!s.objectives||typeof s.objectives!=='object'||Array.isArray(s.objectives)||!s.materials||typeof s.materials!=='object'||Array.isArray(s.materials))throw Error('Invalid backup');
 if(s.inventoryVersion!==undefined&&s.inventoryVersion!==1&&s.inventoryVersion!==2&&s.inventoryVersion!==3)throw Error('Unsupported progress format');
 const ids=new Set(data.quests.map(q=>q.id));
 if(s.completed.some(id=>!ids.has(id))||new Set(s.completed).size!==s.completed.length)throw Error('Unknown quest');
 const objectives=migrateObjectives(s.objectives,s.objectiveVersion??0);
 for(const [id,a] of Object.entries(objectives))if(!ids.has(id)||!Array.isArray(a)||a.some(i=>!Number.isInteger(i)||i<0||i>=by[id].objectives.length))throw Error('Invalid objective');
 const supplyNames=new Set(data.materials.map(m=>m.name)),retiredNames=new Set(data.questItems||[]),materials={};
 for(const [n,v] of Object.entries(s.materials)){
  // Version 2 saves may contain retired non-quest supplies. Validate their
  // quantities, then keep only the restored quest supply catalog.
  if((s.inventoryVersion!==2&&!supplyNames.has(n)&&!retiredNames.has(n))||!Number.isSafeInteger(v)||v<0||v>99999)throw Error('Invalid quantity');
  if(supplyNames.has(n))materials[n]=v;
 }
 // Preserve previously recorded turn-ins affected by source corrections.
 // New turn-ins still require every current prerequisite via unlocked().
 for(const id of s.completed)if(!by[id].prerequisites.every(p=>s.completed.includes(p)||({ 'on-deaf-ears':['snap-and-salvage'],'back-on-top':['the-majors-footlocker'],'combat-recon':['out-of-the-shadows']}[id]?.includes(p))))throw Error('Completed quest has incomplete prerequisites');
 if(s.raids!==undefined&&(!Array.isArray(s.raids)||s.raids.some(n=>!Number.isInteger(n)||n<1||n>1000000)))throw Error('Invalid deployments');
 const questDeductions={};
 if(s.inventoryVersion===3){
  if(s.questDeductions!==undefined&&(!s.questDeductions||typeof s.questDeductions!=='object'||Array.isArray(s.questDeductions)))throw Error('Invalid quest deductions');
  for(const [id,items] of Object.entries(s.questDeductions||{})){
   if(!s.completed.includes(id)||!items||typeof items!=='object'||Array.isArray(items))throw Error('Invalid quest deductions');
   questDeductions[id]={};
   for(const [name,n] of Object.entries(items)){
    if(!supplyNames.has(name)||!Number.isSafeInteger(n)||n<0||n>questItemQty(by[id],name))throw Error('Invalid quest deduction');
    questDeductions[id][name]=n;
   }
  }
 }else{
  // Unversioned/v1 saves used cumulative collection totals; v2 already stored
  // a current balance. Preserve each format's previous available inventory.
  const pools={...materials};
  for(const id of s.completed){
   const deducted={};
   for(const name of new Set(by[id].requiredItems.map(i=>i.name))){
    if(!supplyNames.has(name))continue;
    const required=questItemQty(by[id],name),n=s.inventoryVersion===2?required:Math.min(pools[name]||0,required);
    if(n){deducted[name]=n;if(s.inventoryVersion!==2)pools[name]-=n;}
   }
   if(Object.keys(deducted).length)questDeductions[id]=deducted;
  }
  if(s.inventoryVersion!==2)for(const name of Object.keys(materials))materials[name]=pools[name];
 }
 if(s.rewardOptOut!==undefined&&(!Array.isArray(s.rewardOptOut)||new Set(s.rewardOptOut).size!==s.rewardOptOut.length||s.rewardOptOut.some(name=>!data.materials.some(m=>m.name===name&&m.rewardSources?.length))))throw Error('Invalid reward preference');
 if(s.deploymentCount!==undefined&&(!Number.isSafeInteger(s.deploymentCount)||s.deploymentCount<0||s.deploymentCount>999999))throw Error('Invalid deployment count');
 if(s.lastMap!==undefined&&!getPlanner().maps.includes(s.lastMap))throw Error('Invalid last map');
 if(s.carryover!==undefined&&(!Array.isArray(s.carryover)||s.carryover.some(id=>!ids.has(id))))throw Error('Invalid carried quests');
 let active;
 if(s.activeDeployment!==undefined){
  const a=s.activeDeployment,raidMap=a?.map??(data.legacyRaids||data.raids).find(r=>r.number===a?.number)?.map;
  if(!Number.isSafeInteger(a?.number)||a.number<1||a.number>1000000||!getPlanner().maps.includes(raidMap)||!Array.isArray(a.quests)||!a.quests.length||new Set(a.quests).size!==a.quests.length||a.quests.some(id=>!ids.has(id)))throw Error('Invalid active deployment');
  if(a.quests.every(id=>s.completed.includes(id)||by[id].prerequisites.every(p=>s.completed.includes(p))))active={number:a.number,map:raidMap,quests:[...a.quests]};
 }
 return {inventoryVersion:3,questDeductions,completed:[...s.completed],objectives:structuredCloneSafe(objectives),objectiveVersion:data.objectiveVersion||0,materials,raids:[...(s.raids||[])],...(s.rewardOptOut!==undefined?{rewardOptOut:[...s.rewardOptOut]}:{}),...(s.deploymentCount!==undefined?{deploymentCount:s.deploymentCount}:{}),...(s.lastMap!==undefined?{lastMap:s.lastMap}:{}),...(s.carryover!==undefined?{carryover:[...new Set(s.carryover)]}:{}),...(active?{activeDeployment:active}:{})};
}
function save(){if(!cloudReady)throw Error('Wait for your account progress to load.');try{localStorage.setItem(storageKey,JSON.stringify(state));$('#save-label').textContent='Saved on this browser'}catch{$('#save-label').textContent='Saving unavailable';notice('Browser storage is unavailable. Save a progress backup.')}window.dispatchEvent(new CustomEvent('arc-progress-changed',{detail:{state:JSON.parse(JSON.stringify(state)),storageKey}}));}
function complete(id,value,replan=false){
 if(!cloudReady)throw Error('Wait for your account progress to load.');
 if(view==='next'&&selectedRaid)throw Error('Select the Next Raid tab to return to the current deployment and change progress.');
 const q=by[id];if(!q)throw Error('Unknown quest');if(value&&!unlocked(q))throw Error('Finish prerequisites first');
 retainCurrentBrief();
 if(value&&!isDone(id)){
  const deductions={};
  for(const i of q.requiredItems){
   if(i.use==='carry'||!data.materials.some(m=>m.name===i.name))continue;
   const n=Math.min(available(i.name),i.qty);if(n){state.materials[i.name]-=n;deductions[i.name]=(deductions[i.name]||0)+n;}
  }
  state.questDeductions[id]=deductions;state.completed.push(id);
 }
 if(!value){const remove=new Set([id]);let changed=true;while(changed){changed=false;for(const c of state.completed)if(by[c].prerequisites.some(p=>remove.has(p))&&!remove.has(c)){remove.add(c);changed=true}}for(const reopened of remove){for(const [name,n] of Object.entries(state.questDeductions[reopened]||{}))state.materials[name]=Math.min(99999,available(name)+n);delete state.questDeductions[reopened];}state.completed=state.completed.filter(c=>!remove.has(c));if(remove.size>1)notice('Dependent quests reopened to keep the unlock chain consistent.');}
 settleDeployment();if(replan)delete state.activeDeployment;save();render();
 if(value){const keeps=rewardKeep(q);if(keeps.length)notice('Reward reminder: keep '+keeps.map(r=>r.qty+' '+r.name+' for '+r.uses.map(u=>by[u.id].name).join(' / ')).join('; ')+'. Record retained rewards in Supplies.');}
}
function finishDeployment(n){
 if(!cloudReady)throw Error('Wait for your account progress to load.');
 const r=nextRaid();if(selectedRaid||!r||r.number!==n)throw Error('Finish the recommended deployment, not a projected preview.');
 state.deploymentCount=r.number;state.lastMap=r.map;
 state.carryover=[...new Set([...(state.carryover||[]),...r.quests])].filter(id=>!isDone(id));
 delete state.activeDeployment;selectedRaid=null;
 const next=nextRaid();if(next)state.activeDeployment={number:next.number,map:next.map,quests:[...next.quests]};
 save();render();notice(next?`${next.map===r.map?'Return to':'Next deployment:'} ${data.maps[next.map].name}. Route recalculated from your completed quests and remaining objectives.`:'Deployment finished. Campaign complete.');
}
function quantity(name,n){if(!cloudReady)throw Error('Wait for your account progress to load.');if(!data.materials.some(m=>m.name===name)||!Number.isSafeInteger(n)||n<0||n>99999)throw Error('Enter a whole number from 0 to 99,999');state.materials[name]=n;save();render()}
const rewardExcluded=name=>!!state.rewardOptOut?.includes(name);
const rewardSources=m=>(routePlan().rewards[m.name]||[]).map(r=>{const uses=r.uses.filter(u=>recommendable(by[u.id])&&!isDone(u.id));return {...r,uses,credit:uses.reduce((n,u)=>n+u.credit,0)}}).filter(r=>r.uses.length);
const materialCredit=m=>rewardSources(m).reduce((n,r)=>n+r.credit,0);
const materialTarget=m=>Math.max(0,remainingTotal(m)-materialCredit(m));
function rewardKeep(q){return data.materials.filter(m=>!rewardExcluded(m.name)).flatMap(m=>(m.rewardSources||[]).filter(r=>r.id===q.id).map(r=>{const uses=r.uses.filter(u=>recommendable(by[u.id])&&u.possible&&!isDone(u.id));return {name:m.name,qty:Math.min(r.qty,uses.reduce((n,u)=>n+u.qty,0)),uses};})).filter(r=>r.qty)}
function plannedRewards(name,ids){const m=data.materials.find(m=>m.name===name);return (m?rewardSources(m):[]).map(r=>({...r,needed:r.uses.filter(u=>ids.includes(u.id)).reduce((n,u)=>n+u.credit,0)})).filter(r=>r.needed)}
function futureSupplies(r){
 const plan=routePlan(),index=plan.steps.findIndex(a=>a.number===r.number),steps=index<0?[]:plan.steps.slice(index+1,index+4),current=new Set(briefQuests(r)),quests=new Map();
 for(const step of steps)for(const id of step.quests)if(!isDone(id)&&!current.has(id)&&!quests.has(id))quests.set(id,{id,step:step.number});
 const futureIds=[...quests.keys()];
 const items=data.materials.map(m=>{
  const uses=[...quests.values()].flatMap(q=>by[q.id].requiredItems.filter(i=>i.name===m.name).map(i=>({...q,qty:i.qty,use:i.use})));
  const total=uses.reduce((n,q)=>n+q.qty,0);
  const reserveIds=new Set(plan.steps.slice(0,index+1).flatMap(a=>a.quests));
  const reserved=[...reserveIds].filter(id=>!isDone(id)).reduce((n,id)=>n+by[id].requiredItems.filter(i=>i.name===m.name).reduce((sum,i)=>sum+i.qty,0),0);
  const have=Math.min(total,Math.max(0,available(m.name)-reserved));let collect=Math.max(0,total-have);
  const rewards=plannedRewards(m.name,futureIds).flatMap(source=>{const qty=Math.min(collect,source.needed);collect-=qty;return qty?[{id:source.id,qty}]:[]});
  return {name:m.name,total,have,collect,rewards,quests:uses};
 }).filter(m=>m.total).sort((a,b)=>Math.min(...a.quests.map(q=>q.step))-Math.min(...b.quests.map(q=>q.step))||a.name.localeCompare(b.name));
 return {steps,items};
}
function lookAheadPanel(r){
 const {steps,items}=futureSupplies(r),needed=items.filter(m=>m.collect||m.rewards.length);
 const range=steps.length?String(steps[0].number).padStart(2,'0')+(steps.length>1?'–'+String(steps.at(-1).number).padStart(2,'0'):''):'';
 return `<section class="panel lookahead" aria-label="Supplies for the next three planned deployments"><div class="panel-head"><h2>Look out for</h2><span class="pill">${steps.length?'NEXT '+steps.length:'FINAL STEP'}</span></div>${steps.length?`<div class="panel-body"><p class="small lookahead-intro">Projected deployments ${range}, assuming the current brief’s objectives and turn-ins are completed. Save these finds for upcoming quests; current needs are reserved first.</p></div>${needed.length?needed.map(m=>`<div class="lookahead-row"><strong>${m.collect?`Be on the lookout for ${m.collect}× ${supplyName(m.name,true)}`:`Save ${m.rewards.reduce((n,s)=>n+s.qty,0)}× ${supplyName(m.name,true)} from quest rewards`}</strong><p>Needed for: ${m.quests.map(q=>`${q.qty}× for ${esc(by[q.id].name)} · step ${String(q.step).padStart(2,'0')} · ${itemUseLabel(q.use)}`).join('; ')}.</p>${m.have?`<p>${m.have} already available for these quests after earlier/current needs.</p>`:''}${m.rewards.map(s=>`<p class="lookahead-reward"><strong>Reserve ${s.qty}× ${supplyName(m.name,true)} from ${esc(by[s.id].name)}.</strong> ${isDone(s.id)?'Reward already awarded; check that you kept it and recorded it in Supplies.':'This reward will be awarded after turn-in; save it for the named quest.'}</p>`).join('')}</div>`).join(''):'<div class="empty">No extra supplies to collect for these upcoming steps.</div>'}`:'<div class="empty">No later planned deployments.</div>'}</section>`;
}
function questRewardNotes(q,raidOnly=false){
 const keeps=rewardKeep(q),receiving=data.materials.flatMap(m=>rewardSources(m).filter(r=>r.uses.some(u=>u.id===q.id&&u.credit)).map(r=>({name:m.name,source:r.id,qty:r.uses.find(u=>u.id===q.id).credit})));
 const rewards=raidOnly?q.rewards.filter(r=>keeps.some(k=>k.name===r.name)):q.rewards;
 return `${rewards.length?`<div class="quest-rewards"><strong>${isDone(q.id)?'Rewards awarded':'Rewards after turn-in'}:</strong> ${rewards.map(r=>`${r.qty}× ${esc(r.name)}`).join(' · ')}${q.rewardsSource?` <a class="reward-source" href="${esc(q.rewardsSource)}" target="_blank" rel="noopener">Reward source</a>`:''}</div>`:''}${keeps.length?`<div class="reward-reminder"><strong>${raidOnly?'SAVE THIS REWARD FOR A FUTURE QUEST':'Save for a future quest:'}</strong><ul>${keeps.map(r=>`<li>Keep ${r.qty}× <strong>${esc(r.name)}</strong> for ${r.uses.map(u=>esc(by[u.id].name)).join(' / ')}.${r.uses.length>1?` Share these ${r.qty} across the remaining requirements.`:''}</li>`).join('')}</ul><span class="small">After receiving the reward, include the amount you kept in Supplies’ stash quantity. Keep it safe until the matching quest needs it.</span></div>`:''}${!isDone(q.id)&&receiving.length?`<div class="reward-reminder incoming-reward"><strong>Quest reward source:</strong><ul>${receiving.map(r=>`<li>Use ${r.qty}× ${esc(r.name)} from <strong>${esc(by[r.source].name)}</strong>. ${isDone(r.source)?'Check that you kept it and recorded it in Supplies.':'Finish that quest first and save the reward.'}</li>`).join('')}</ul></div>`:''}`;
}
function raidPrepNotice(q,raidMap){
 if(!recommendable(q)||isDone(q.id))return '';
 if(q.raidPrepChoices?.length)return `<section class="raid-prep" aria-label="Raid loadout for ${esc(q.name)}"><h4>BRING INTO RAID</h4><p><strong>Choose ONE access route. You do not need both loadouts.</strong></p><ul>${q.raidPrepChoices.map(c=>`<li><strong>${esc(c.title)}</strong><p><strong class="raid-prep-item" data-no-translate>${c.items.map(i=>`${i.qty}× ${esc(i.name)}`).join(' + ')}</strong></p><p>${esc(c.purpose)}</p>${c.providedNotice?`<p class="provided-kit">${esc(c.providedNotice)}</p>`:''}</li>`).join('')}</ul></section>`;
 const items=(q.raidPrep||[]).filter(i=>(!raidMap||!i.maps||i.maps.includes(raidMap))&&(q.cameraRequired!==false||i.name.toLowerCase()!=='basic camera'));
 const needsCamera=q.cameraRequired!==false&&(q.objectives.some(o=>/\b(?:photograph\w*|(?:take|snap)\s+(?:a\s+)?photos?)\b/i.test(o))||q.objectiveGraph?.nodes.some(n=>n.action?.type==='Photo'));
 if(needsCamera&&!items.some(i=>i.name.toLowerCase()==='basic camera'))items.push({name:'Basic Camera',qty:1,required:true,purpose:'Remember to bring a Basic Camera into the raid to complete this quest’s photo objectives.'});
 if(q.id==='sizing-things-up'&&getPlanner().choiceStatus(q.id,0,getPlanner().snapshot(state))==='satisfied'){const index=items.findIndex(i=>i.name.toLowerCase()==='basic camera');if(index>=0)items.splice(index,1);}
 const cameraGranted=(q.grantedItems||[]).some(i=>i.name.toLowerCase()==='basic camera'&&i.qty>0);
 const cameraMessage=cameraGranted?'Bring the Basic Camera provided when accepting this quest into the raid for the photo objectives.':'Bring a Basic Camera into the raid for the photo objectives. This quest does not supply one: craft one or use a camera you saved from a previous raid.';
 if(!items.length)return '';
 return `<section class="raid-prep" aria-label="Raid loadout for ${esc(q.name)}"><h4>${items.some(i=>i.required)?'BRING INTO RAID':'RECOMMENDED ACCESS GEAR'}</h4><ul>${items.map(i=>`<li><strong class="raid-prep-item">${i.minimum?'At least ':''}${i.qty?i.qty+'× ':''}${esc(i.name)}</strong><p>${esc(i.name.toLowerCase()==='basic camera'?(q.id==='sizing-things-up'?'If choosing the photo option: ':'')+cameraMessage:i.purpose)}</p>${i.origin==='quest'&&i.name.toLowerCase()!=='basic camera'?`<p class="provided-kit">Provided free when you accept this quest: ${i.provided.map(g=>`${g.qty}× ${esc(g.name)}`).join(' · ')}. <strong>Do not sell or recycle the gear you need for this quest. Remember to pack it before deploying.</strong></p>`:''}</li>`).join('')}</ul><a class="reward-source" href="${esc(q.raidPrepSource)}" target="_blank" rel="noopener">Preparation source</a></section>`;
}
function questItemSummary(q){
 return [['turn-in','Turn-in'],['raid','Use in raid'],['carry','Carry into raid (reusable)'],['find-and-use','Find and use during the quest']].map(([use,label])=>{const items=q.requiredItems.filter(i=>(i.use||'turn-in')===use);return items.length?`<div class="quest-foot">${label}: ${items.map(i=>`${i.qty}× ${esc(i.name)}`).join(' · ')}</div>`:''}).join('');
}
const itemUseLabel=use=>use==='raid'?'Use in raid':use==='carry'?'Carry into raid (reusable)':'Turn-in';
function rewardSourceNote(m,r){
 const future=r.uses.filter(u=>u.credit),possible=r.uses.filter(u=>u.possible);
 const intro=`${r.qty}× ${esc(m.name)} ${isDone(r.id)?'was awarded':'will be received as a quest reward'} from <strong>${esc(by[r.id].name)}</strong>.`;
 if(rewardExcluded(m.name))return `<div class="supply-reward-note later-reward">${intro} <strong>Reward deduction turned off.</strong> Collect a replacement if you did not keep it.</div>`;
 if(r.credit)return `<div class="supply-reward-note">${intro} Save ${r.credit} for ${future.map(u=>esc(by[u.id].name)).join(' / ')}. <strong>${r.credit} deducted from the collection target.</strong>${isDone(r.id)?' Record how much you actually kept in the stash quantity.':''}</div>`;
 return `<div class="supply-reward-note later-reward">${intro} ${possible.length?`It comes later than ${r.uses.map(u=>esc(by[u.id].name)).join(' / ')} in the planned route; keep it if a matching quest is still open.`:`${r.uses.map(u=>esc(by[u.id].name)).join(' / ')} must be completed before this reward is available.`} <strong>No earlier requirement deducted.</strong></div>`;
}
function stats(){const done=campaignDone(),total=campaignQuests().length,percent=Math.round(done/total*100),ready=data.quests.filter(q=>!isDone(q.id)&&unlocked(q)).length,materials=activeMaterials(),mats=materials.filter(m=>available(m.name)>=materialTarget(m)).length;updateRaidEstimate();$('#side-fraction').textContent=`${done} / ${total}`;$('#side-meter').style.width=`${percent}%`;$('#nav-count').textContent=total-done;$('#supplies-count').textContent=materials.length;return `<div class="stats"><div class="stat"><strong>${String(done).padStart(2,'0')}<span style="font-size:20px;color:var(--muted)"> /${total}</span></strong><div><div class="stat-label">QUESTS COMPLETED</div><small>${percent}% of campaign</small></div></div><div class="stat"><strong>${String(ready).padStart(2,'0')}</strong><div><div class="stat-label">QUESTS UNLOCKED</div><small>Ready to work on</small></div></div><div class="stat"><strong>${mats}<span style="font-size:20px;color:var(--muted)"> /${materials.length}</span></strong><div><div class="stat-label">COLLECTION TARGETS MET</div><small>Extra collection targets covered</small></div></div></div>`}
function questUnlockNotice(q,active){
 if(!active||isDone(q.id)||!unlocked(q))return '';
 const followups=data.quests.filter(next=>recommendable(next)&&!isDone(next.id)&&next.prerequisites.includes(q.id)&&next.prerequisites.every(id=>id===q.id||isDone(id)));
 return followups.length?`<div class="quest-unlock"><strong>Completion unlocks:</strong> ${followups.map(next=>esc(next.name)).join(' · ')}</div>`:'';
}
function objectiveLabel(q,i,raidMap){
 if(!raidMap||objectiveDone(q,i))return '';
 const p=getPlanner();
 if(q.objectiveRules?.[i]?.optional||/\(optional\)/i.test(q.objectives[i]))return '<small class="objective-context">Optional objective</small>';
 if(p.turnInObjective(q.id,i))return '<small class="objective-context">After extraction · turn in to the trader</small>';
 const snapshot=p.snapshot(state),choice=p.choiceStatus(q.id,i,snapshot);
 if(choice==='unselected')return '<small class="objective-context">Another prototype selected · finish the one you started</small>';
 if(choice==='satisfied')return '<small class="objective-context">Alternative satisfied · no additional visit needed</small>';
 if(choice==='alternative'&&q.choiceGroups)return `<small class="objective-context">${p.objectiveMaps(q.id,i).includes(raidMap)?'Available choice on this map':'Alternative choice · '+p.objectiveMaps(q.id,i).map(m=>esc(data.maps[m].name)).join(' / ')}</small>`;
 const job=p.work(q,raidMap,snapshot);
 if(job.indices.includes(i))return '<small class="objective-context current-objective">Focus this deployment</small>';
 const locations=p.objectiveMaps(q.id,i).map(m=>esc(data.maps[m].name)).join(' / ');
 if(choice==='alternative')return `<small class="objective-context">Alternative route · ${locations}</small>`;
 return `<small class="objective-context">${p.objectiveMaps(q.id,i).includes(raidMap)?'Complete the earlier quest stage first':'Later deployment · '+locations}</small>`;
}
function remainingObjectiveNotice(q,raidMap){
 if(!raidMap||!recommendable(q)||isDone(q.id))return '';
 const p=getPlanner(),s=p.snapshot(state),locations=p.remainingMaps(q.id,s).filter(m=>m!==raidMap);
 const job=p.work(q,raidMap,s);
 if(job.waiting)return '<div class="quest-foot">Raid objectives complete. Turn this quest in after extraction.</div>';
 if(!p.multiMap(q.id))return '';
 if(!job.indices.length)return `<div class="quest-foot">No unfinished objectives on this map. Remaining raid work: ${locations.map(m=>esc(data.maps[m].name)).join(' / ')}. Finish this deployment to update your route.</div>`;
 return `<div class="quest-foot">${job.finishable?'This deployment can finish the remaining raid objectives.':'Other remaining map objectives: '+locations.map(m=>esc(data.maps[m].name)).join(' / ')+'.'}</div>`;
}
let objectiveMapOpener=null,objectiveMapZoom=1;
function zoomObjectiveMap(change){objectiveMapZoom=Math.max(1,Math.min(3,objectiveMapZoom+change));document.querySelectorAll('#objective-map-media .objective-map-image').forEach(el=>el.style.width=(objectiveMapZoom*100)+'%');$('#objective-map-zoom-label').textContent=Math.round(objectiveMapZoom*100)+'%';}
$('#objective-map-zoom-in').onclick=()=>zoomObjectiveMap(.5);
$('#objective-map-zoom-out').onclick=()=>zoomObjectiveMap(-.5);
function objectiveMapEntry(q,i){return globalThis.ARCObjectiveMaps?.[q.id]?.[i]}
function objectiveText(q,i,text){const entry=objectiveMapEntry(q,i);return entry?`<a href="#objective-map" class="objective-location" data-objective-map="${q.id}" data-map-index="${i}" aria-haspopup="dialog">${esc(text)}<span class="map-link-icon" aria-hidden="true"> ↗ Map</span></a>`:`<label for="objective-${q.id}-${i}">${esc(text)}</label>`}
function closeObjectiveMap(){$('#objective-map').close()}
let objectiveMapSelection=null,objectiveMapOverview=false;
function objectiveMapMedia(entry,overview=false){
 const images=overview&&entry.overviewImages?.length?entry.overviewImages:entry.images;
 return images.map(im=>`<figure><figcaption>${esc(im.title||'Objective location')}</figcaption><div class="map-viewport"><div class="objective-map-image"><img src="${esc(im.src)}" alt="${esc(im.alt)}" width="${im.width}" height="${im.height}" loading="lazy">${(im.markers||[]).map((m,n)=>`<span class="map-point" style="left:${m.x/100}%;top:${100-m.y/100}%" role="img" aria-label="Location ${m.number||n+1}: ${esc(m.label)}"><i aria-hidden="true"></i><b aria-hidden="true">${m.number||n+1}</b></span>`).join('')}</div></div>${im.markers?`<ol class="map-marker-list">${im.markers.map((m,n)=>`<li value="${m.number||n+1}">${esc(m.label)}${m.note&&m.note!=='—'?' — '+esc(m.note):''}</li>`).join('')}</ol>`:''}</figure>`).join('');
}
function renderObjectiveMapMedia(){
 const entry=objectiveMapSelection;if(!entry)return;
 $('#objective-map-media').innerHTML=objectiveMapMedia(entry,objectiveMapOverview);
 $('#objective-map-view').textContent=objectiveMapOverview?'Show close-up':'Show full map';
 $('#objective-map-view').setAttribute('aria-pressed',String(objectiveMapOverview));
 $('#objective-map-media').querySelectorAll?.('img').forEach(img=>img.onerror=()=>{img.alt='Map image could not load. Try the full map or reopen to retry.';notice('Map image could not load. Try Show full map.');});
 objectiveMapZoom=1;zoomObjectiveMap(0);
}
function toggleObjectiveMapView(){if(!objectiveMapSelection)return;objectiveMapOverview=!objectiveMapOverview;renderObjectiveMapMedia();}
$('#objective-map-view').onclick=toggleObjectiveMapView;
function openObjectiveMap(id,index,opener){
 const q=by[id],entry=q&&objectiveMapEntry(q,index);if(!entry)return;
 objectiveMapOpener=opener;objectiveMapSelection=entry;objectiveMapOverview=false;const dialog=$('#objective-map');
 $('#objective-map-title').textContent=q.name;
 $('#objective-map-objective').textContent=q.objectives[index].replace(/^●\s*/,'');
 $('#objective-map-caption').textContent=entry.caption;
 renderObjectiveMapMedia();
 $('#objective-map-credit').innerHTML=entry.sources.map(src=>`<a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.credit)}</a>`).join(' · ');
 if(!dialog.open)dialog.showModal();dialog.scrollTop=0;document.body?.classList.add('map-overlay-open');$('#objective-map-close').focus?.();
}
$('#objective-map-close').onclick=closeObjectiveMap;
$('#objective-map').onclick=e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeObjectiveMap()};
$('#objective-map').onclose=()=>{document.body?.classList.remove('map-overlay-open');if(objectiveMapOpener?.isConnected)objectiveMapOpener.focus();else document.querySelector(`[data-objective-map="${objectiveMapOpener?.dataset.objectiveMap}"][data-map-index="${objectiveMapOpener?.dataset.mapIndex}"]`)?.focus?.();objectiveMapOpener=null;objectiveMapSelection=null;};
function questObjectiveRows(q,raidMap,preview=false){
 const s=status(q);
 const row=i=>{
  const text=q.objectives[i].replace(/^●\s*/,'');
  const optional=q.objectiveRules?.[i]?.optional||/\(optional\)/i.test(text);
  const optionalNote=optional?(q.objectiveRules?.[i]?.optionalNotice||'Optional bonus objective: not required to complete the quest. Complete it for bonus rewards at turn-in.'):'';
  const rule=q.objectiveRules?.[i]||{},waiting=rule.requiresObjectives?.some(parent=>!objectiveDone(q,parent));
  const classes=[optional?'optional-objective':'',rule.substep?'objective-substep':'',waiting?'objective-waiting':''].filter(Boolean).join(' ');
  const count=rule.displayCount?`<small class="objective-count">${objectiveDone(q,i)?rule.displayCount:0}/${rule.displayCount}</small>`:'';
  const round=q.objectiveGraph?.nodes.find(n=>n.id===q.objectiveGraph.root)?.round_constraint!=='IN_ONE_ROUND'&&getPlanner().oneRoundObjective(q.id,i)?'<small class="objective-context">One round · finish together with the other one-round steps</small>':'';
  return ARCPlanner.heading(text)?`<li class="small">${esc(text)}</li>`:`<li${classes?` class="${classes}"`:''}><div class="objective"><input type="checkbox" id="objective-${q.id}-${i}" aria-label="${esc(text)}" data-objective="${q.id}" data-index="${i}" ${objectiveDone(q,i)?'checked':''} ${s==='paused'||s==='locked'||s==='done'||preview||waiting?'disabled':''}><span>${objectiveText(q,i,text)}${count}${optionalNote?`<small class="optional-note">${esc(optionalNote)}</small>`:''}${round}${objectiveLabel(q,i,raidMap)}</span></div></li>`;
 };
 let indices=q.objectiveDisplayOrder||q.objectives.map((_,i)=>i);
 if(q.id==='to-the-skies'){
  const currentMap=raidMap||(view==='quests'&&q.maps.includes(map)?map:nextRaid()?.map);
  if(q.maps.includes(currentMap))indices=indices.filter(i=>q.objectiveRules?.[i]?.maps.includes(currentMap));
 }
 if(q.choiceGroups?.length){
  const grouped=new Set(q.choiceGroups.flatMap(g=>g.options.flatMap(o=>o.indices))),rendered=new Set();
  return indices.map(i=>{
   if(!grouped.has(i))return row(i);
   const group=q.choiceGroups.find(g=>g.options.some(o=>o.indices.includes(i)));if(rendered.has(group))return '';rendered.add(group);
   const count=group.options.filter(o=>o.required.every(i=>objectiveDone(q,i))).length;
   return `<li class="objective-choice-group"><div class="choice-group-heading"><strong>${esc(group.title)}</strong><small>${count>=group.needed?'Requirement met':`${count} / ${group.needed} required choices completed`}</small></div>${group.options.map(o=>`<section class="objective-choice-option"><h4>${esc(o.title)}</h4><ul>${o.indices.map(row).join('')}</ul></section>`).join('')}</li>`;
  }).join('');
 }
 return indices.map(row).join('');
}

function questCard(q,raidMap,carriedFrom,preview=false){const s=status(q),missing=q.prerequisites.filter(p=>!isDone(p));return `<article class="quest-card ${s==='done'?'completed-card':s==='paused'?'paused-quest':''}"><div class="quest-top"><input type="checkbox" class="check" data-quest="${q.id}" aria-label="Mark ${esc(q.name)} completed after turn-in" ${isDone(q.id)?'checked':''} ${s==='paused'||s==='locked'||preview?'disabled':''}><div class="quest-info"><div class="quest-title"><h3 data-no-translate>${esc(q.name)}</h3><span class="pill ${s}">${s==='ready'?(getPlanner().remainingMaps(q.id,getPlanner().snapshot(state)).length?'Unlocked':'Ready to turn in'):s==='done'?'Completed':s==='paused'?'Paused':'Locked'}</span></div><div class="quest-meta">${esc(data.traders[q.trader].name)} · ${q.maps.map(m=>esc(data.maps[m].name)).join(' / ')}</div>${carriedFrom?`<div class="carry-label">Continuing from an earlier deployment</div>`:''}</div></div>${q.raidEnabled===false?`<div class="quest-foot paused-notice"><strong>Not included in raid recommendations.</strong> ${esc(q.disabledReason)}</div>`:''}${questUnlockNotice(q,!!raidMap&&!preview&&view==='next')}${raidPrepNotice(q,raidMap)}${q.objectiveGraph?.nodes.find(n=>n.id===q.objectiveGraph.root)?.round_constraint==='IN_ONE_ROUND'&&!isDone(q.id)?`<div class="quest-foot"><strong>In one round:</strong> complete every objective in the same raid.</div>`:''}${q.routeNotes?`<div class="quest-foot"><strong>Objective choices:</strong> ${esc(q.routeNotes)}</div>`:''}${q.eventNotice?`<div class="raid-prep"><strong>Map event required:</strong> ${esc(q.eventNotice)}</div>`:''}${missing.length?`<div class="blocked">Requires: ${missing.map(p=>esc(by[p].name)).join(' + ')}</div>`:''}<ul class="objectives">${questObjectiveRows(q,raidMap,preview)}</ul>${questItemSummary(q)}${questRewardNotes(q,!!raidMap)}${remainingObjectiveNotice(q,raidMap)}</article>`}
function heading(title,subtitle,action=''){return `<div class="page-head"><div><div class="eyebrow">CAMPAIGN / ${view==='next'?'DEPLOYMENT BRIEF':view==='materials'?'RESOURCE MANAGEMENT':'QUEST LOG'}</div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>${action}</div>`}
function undoButton(){const q=by[state.completed.at(-1)];return `<button id="undo-quest" class="button secondary" ${q?`aria-label="Undo completion of ${esc(q.name)}" title="Reopen ${esc(q.name)}"`:'disabled title="No completed quest to undo"'}><span aria-hidden="true">↶</span> Undo last quest</button>`}
function undoQuest(){if(!cloudReady)throw Error('Wait for your account progress to load.');const id=state.completed.at(-1);if(!id)return;selectedRaid=null;complete(id,false,true);notice(`Reopened ${by[id].name}. Recommendation refreshed; your objective checks are kept.`)}
let resetStorageKey=null;
function campaignButtons(){return undoButton()+`<button id="reset-campaign" class="button secondary" ${!cloudReady?'disabled':''}>Reset campaign</button>`}
function closeCampaignReset(){resetStorageKey=null;$('#campaign-reset').close()}
function openCampaignReset(){
 if(!cloudReady)throw Error('Wait for your account progress to load.');
 resetStorageKey=storageKey;
 $('#reset-message').textContent=`This clears all quest completions, objective checks, collected supplies, deployment history and reward preferences ${storageKey===KEY?'for this browser’s guest campaign':'for your current Google account’s campaign'}. Your campaign will start again at step 1.`;
 $('#campaign-reset').showModal();
}
function resetCampaign(){
 if(!cloudReady)throw Error('Wait for your account progress to load.');
 if(resetStorageKey===null||resetStorageKey!==storageKey)throw Error('Your active campaign changed. Open Reset campaign again to confirm.');
 state={completed:[],objectives:{},objectiveVersion:data.objectiveVersion||0,materials:{},raids:[],inventoryVersion:3,questDeductions:{}};
 stopRouteSearch();planCache=null;try{localStorage.removeItem?.(storageKey+':route-v2')}catch{}
 map='all';selectedRaid=null;closeCampaignReset();save();go('next');notice('Campaign reset. Ready for your first raid.');
}
function nextView(){
 const plan=routePlan(),automatic=nextRaid();if(selectedRaid&&!plan.steps.some(a=>a.number===selectedRaid))selectedRaid=null;
 const r=selectedRaid?plan.steps.find(a=>a.number===selectedRaid):automatic,preview=!!selectedRaid;
 if(!r)return heading('Campaign complete',`All ${campaignQuests().length} quests turned in. Speranza is in good hands.`,campaignButtons())+stats()+`<div class="panel panel-body finished"><h2>Mission accomplished.</h2><p>Your completed campaign is saved.</p></div>`;
 const qs=briefQuests(r).map(id=>by[id]),ready=qs.filter(q=>!isDone(q.id)&&(preview||unlocked(q)));
 const mats={};for(const q of ready)for(const i of q.requiredItems)if(data.materials.some(m=>m.name===i.name))mats[i.name]=(mats[i.name]||0)+i.qty;
 const needs=Object.entries(mats).map(([name,n])=>({name,n,have:available(name),missing:Math.max(0,n-available(name)),uses:[...new Set(ready.flatMap(q=>q.requiredItems.filter(i=>i.name===name).map(i=>itemUseLabel(i.use))))]}));
 const upcoming=plan.steps.filter(a=>a.number>r.number).slice(0,3);
 return heading('Next raid','Check quests after turn-in. Finish deployment to recalculate your route.',`<div class="raid-actions">${campaignButtons()}<select id="raid-select" class="raid-selector" hidden aria-label="Preview a projected deployment"><option value="auto" ${!selectedRaid?'selected':''}>Recommended deployment</option>${plan.steps.slice(1).map(a=>`<option value="${a.number}" ${a.number===selectedRaid?'selected':''}>${String(a.number).padStart(2,'0')} · ${esc(data.maps[a.map].name)} · projected</option>`).join('')}</select></div>`)+stats()+`<div class="two-col"><section class="deployment"><div class="deployment-head" data-deployment-map="${esc(r.map)}"><img class="deployment-banner-image" src="maps/banners/${esc(r.map)}.webp" alt="" aria-hidden="true" decoding="async"><div><span class="pill ready">${preview?'Projected route preview':'Current deployment'}</span><h2 data-no-translate>${esc(data.maps[r.map].name)}</h2><div class="deployment-meta"><span>${preview?qs.length+' projected quests':ready.length+' unlocked quests'}</span><span>Turn in after extraction</span></div></div><div class="deployment-estimate" title="Based on remaining raid objectives in your current adaptive route"><strong class="raid-number" id="deployment-raids">${raidsRemaining()??'—'}</strong><span>Estimated raids remaining</span></div></div>${preview?'<div class="hint">Preview only. This route assumes earlier objectives and quest turn-ins are completed. Select the Next Raid tab to return to the current deployment and record progress.</div>':''}<div class="section-bar"><span>MISSION OBJECTIVES</span><span>${qs.length} QUESTS</span></div>${qs.map(q=>questCard(q,r.map,state.carryover?.includes(q.id),preview)).join('')}<div class="panel-body"><button id="finish-raid" class="button" data-number="${r.number}" ${preview||!cloudReady?'disabled':''}>Finish this deployment</button><p class="small" style="margin-bottom:0">Checking quests keeps this brief in place. Finish deployment after your raid, even if some quests remain unfinished. The next recommendation uses only actually unlocked quests and unfinished objectives; it may send you back to this map.</p></div><div class="hint"><strong>Before you deploy:</strong> accept unlocked quests in-game. Check objectives during the raid; check the large box only after turning in the full quest. A checked objective does not unlock its follow-up.</div></section><aside><section class="panel"><div class="panel-head"><h2>Supply priorities</h2><span class="pill">THIS RAID</span></div>${needs.length?needs.map(m=>`<div class="loot-row"><div class="supply-priority-info">${supplyIcon(m.name)}<div>${supplyName(m.name)}<small class="supply-use">${m.uses.join(' · ')}</small><small>${m.missing?(plannedRewards(m.name,ready.map(q=>q.id)).length?plannedRewards(m.name,ready.map(q=>q.id)).map(source=>`Reserve ${Math.min(m.missing,source.needed)} from ${esc(by[source.id].name)} · ${isDone(source.id)?'Reward awarded; record what you kept in Supplies':'Complete that quest first'}`).join(' · '):`Collect ${m.missing} more · ${m.have} available`):'Covered by your collected supplies'}</small></div></div><span class="quantity">${Math.min(m.have,m.n)} / ${m.n}</span></div>`).join(''):'<div class="empty">No supplies to collect in advance for these unlocked quests. Follow quest objectives for quest-specific pickups.</div>'}<div class="panel-body"><button class="button secondary" data-go="materials">Manage supplies</button></div></section>${lookAheadPanel(r)}${automatic?`<section class="panel current-deployment-nav"><div class="panel-head"><h2>Current deployment</h2></div><button class="upcoming" data-go="next" ${!preview?'aria-current="true"':''}><span><span data-no-translate>${esc(data.maps[automatic.map].name)}</span><small>${briefQuests(automatic).filter(id=>!isDone(id)&&unlocked(by[id])).length} unlocked quests</small></span></button></section>`:''}<section class="panel"><div class="panel-head"><h2>On the horizon</h2></div>${upcoming.map(a=>`<button class="upcoming" data-raid="${a.number}"><span>${esc(data.maps[a.map].name)}<small>${a.quests.length} projected quests</small></span></button>`).join('')||'<div class="empty">Final stretch of your projected route.</div>'}</section><section class="panel panel-body"><div class="eyebrow">FIELD NOTES</div><p style="margin-top:12px">The route compares unlocked quest bundles, map objectives and follow-up quests to reduce remaining deployments.</p><p class="small">${routeBusy?'Comparing future routes… Your current deployment stays in place.':'Best valid route retained.'} Replanned on Finish Deployment. Future raids and supply advice are projections; partial progress can change their order.</p></section></aside></div>`;
}
function tabs(){return `<div class="map-tabs" role="group" aria-label="Quest map filter"><button class="map-tab ${map==='all'?'active':''}" data-map="all">All maps</button>${Object.entries(data.maps).map(([id,m])=>`<button class="map-tab ${map===id?'active':''}" data-map="${id}">${esc(m.name)}</button>`).join('')}</div>`}
function questView(){const qs=data.quests.filter(q=>(map==='all'||q.maps.includes(map)||(map!=='any'&&q.maps.includes('any')))&&(filter==='all'||status(q)===filter)&&(q.name+' '+data.traders[q.trader].name).toLowerCase().includes(search.toLowerCase())).sort((a,b)=>(a.routingStage||0)-(b.routingStage||0)||a.firstRaid-b.firstRaid);return heading('Quest log','Check objectives in the field. Mark full quests after turning them in.')+stats()+tabs()+`<div class="toolbar"><input class="input" id="quest-search" type="search" placeholder="Find a quest or trader…" value="${esc(search)}" aria-label="Search quests"><select id="quest-filter" aria-label="Filter quest status">${[['all','All statuses'],['ready','Unlocked'],['locked','Locked'],['paused','Paused'],['done','Completed']].map(([v,n])=>`<option value="${v}" ${filter===v?'selected':''}>${n}</option>`).join('')}</select></div><div class="view-count">${qs.length} quests${map!=='all'&&map!=='any'?' · includes Any Map quests':''}</div><div class="quest-grid">${qs.map(q=>questCard(q)).join('')||'<div class="empty">No quests match this view.</div>'}</div>`}
function supplyName(name,withIcon=false){return `<button type="button" class="item-name-link${withIcon?' item-name-with-icon':''}" data-no-translate data-item-name="${esc(name)}" aria-haspopup="dialog">${withIcon?supplyIcon(name):''}<span>${esc(name)}</span></button>`;}
let itemDetailsOpener=null,itemDetailsName=null;
function openItemDetails(name,opener){
 const item=data.materials.find(m=>m.name===name);if(!item)return;
 const details=item.details;
 itemDetailsOpener=opener;itemDetailsName=name;
 $('#item-details-title').textContent=name;
 $('#item-details-icon').src=item.icon||'';$('#item-details-icon').hidden=!item.icon;
 $('#item-details-intro').textContent=details?.summary||'Location details are not yet available for this item.';
 $('#item-details-content').innerHTML=details?`${details.arcDrops?.length?`<section class="item-intel-section"><h3>ARC loot sources</h3><ul>${details.arcDrops.map(drop=>`<li>${esc(drop)}</li>`).join('')}</ul></section>`:''}${details.locations?.length?`<section class="item-intel-section"><h3>Places to search</h3>${details.locations.map(area=>`<div class="item-search-area"><strong>${esc(area.map)}</strong><p>${esc(area.where)}</p></div>`).join('')}</section>`:''}${details.tips?.length?`<section class="item-intel-section"><h3>Looting tips</h3><ul>${details.tips.map(tip=>`<li>${esc(tip)}</li>`).join('')}</ul></section>`:''}${details.note?`<p class="item-source-note">${esc(details.note)}</p>`:''}<div class="item-intel-sources"><span class="small">Sources checked ${esc(details.reviewedAt)}</span><div>${details.sources.map(src=>`<a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.name)}</a>`).join(' · ')}</div></div>`:'';
 const dialog=$('#item-details');if(!dialog.open)dialog.showModal();dialog.scrollTop=0;document.body?.classList.add('item-overlay-open');$('#item-details-close').focus?.();
}
function closeItemDetails(){$('#item-details').close();}
$('#item-details-close').onclick=closeItemDetails;
$('#item-details').onclick=e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeItemDetails();};
$('#item-details').onclose=()=>{document.body?.classList.remove('item-overlay-open');const opener=itemDetailsOpener?.isConnected?itemDetailsOpener:[...document.querySelectorAll('[data-item-name]')].find(el=>el.dataset.itemName===itemDetailsName);opener?.focus?.();itemDetailsOpener=null;itemDetailsName=null;};
function supplyIcon(name){
 const icon=data.materials.find(m=>m.name===name)?.icon;
 return icon?`<img class="supply-icon" src="${esc(icon)}" alt="" aria-hidden="true" width="40" height="40" loading="lazy" decoding="async">`:'';
}
function materialView(){
 const ms=activeMaterials().filter(m=>m.name.toLowerCase().includes(search.toLowerCase())).sort((a,b)=>Math.min(...remainingUses(a).map(q=>by[q.id].firstRaid))-Math.min(...remainingUses(b).map(q=>by[q.id].firstRaid)));
 return heading('Supplies','Collect ahead for future quests. Save useful rewards instead of finding them twice.')+stats()+`<div class="hint" style="margin-bottom:22px">Collection targets subtract rewards that arrive before the matching quest in the planned route. Future rewards are not yet in your stash. Enter how many you currently have in your stash, including rewards you have received and kept. Completing a quest deducts its recorded turn-in items and consumable raid supplies. Reusable carry-in gear stays in your stash. Items disappear here when no unfinished quest needs them; undo restores recorded deductions and brings needed items back. Items marked “Use in raid” or “Carry into raid” must be in your loadout when you need them. Free quest kits appear on quest cards and are excluded from collection targets. Quest-specific pickups stay in the Quest Log. If a planned reward was sold or lost, collect a replacement.</div><div class="toolbar"><input id="material-search" class="input" type="search" placeholder="Find a material…" value="${esc(search)}" aria-label="Search materials"></div><div class="material-grid">${ms.map(m=>{
 const n=state.materials[m.name]||0,target=materialTarget(m),full=n>=target,credit=materialCredit(m);
 return `<article class="material-card"><div class="material-title"><input class="check" type="checkbox" data-material-check="${esc(m.name)}" aria-label="Mark the extra ${esc(m.name)} collection target of ${target} collected" ${full?'checked':''} ${!target?'disabled':''}>${supplyIcon(m.name)}<h3>${supplyName(m.name)}</h3></div><p>${remainingUses(m).map(i=>`${i.qty}× ${esc(by[i.id].name)} (${itemUseLabel(i.use)})`).join(' · ')}</p>${m.rewardSources?.length?`<div class="reward-target"><strong>${target} to collect</strong><span>${remainingTotal(m)} needed for unfinished quests · ${credit} covered by a planned reward</span></div>`:''}${m.rewardSources?.length?`<label class="reward-choice"><input type="checkbox" data-reward-use="${esc(m.name)}" ${rewardExcluded(m.name)?'':'checked'}><span>Use the planned reward<small>Uncheck if you used, sold or lost it.</small></span></label>`:''}${rewardSources(m).map(r=>rewardSourceNote(m,r)).join('')}<div class="meter"><i style="width:${target?Math.min(100,n/target*100):100}%"></i></div><div class="material-count"><div class="stepper"><button data-step="-1" data-name="${esc(m.name)}" aria-label="Decrease ${esc(m.name)} stash quantity">−</button><input type="number" inputmode="numeric" min="0" max="99999" data-quantity="${esc(m.name)}" value="${n}" aria-label="Current ${esc(m.name)} quantity in your stash"><button data-step="1" data-name="${esc(m.name)}" aria-label="Increase ${esc(m.name)} stash quantity">+</button></div><span class="quantity">${n} / ${target}</span></div><div class="small" style="margin-top:12px">${available(m.name)} in stash · ${Math.max(0,target-n)} left in collection target${m.rewardSources?.length?' · Record retained rewards only after receiving them.':''}</div></article>`;
 }).join('')||`<div class="empty">${activeMaterials().length?'No supplies match your search.':'No supplies needed for unfinished quests.'}</div>`}</div>`;
}
function render(){if(!data)return;for(const n of document.querySelectorAll('.nav')){n.classList.toggle('active',n.dataset.view===view);n.setAttribute('aria-current',n.dataset.view===view?'page':'false')}$('#main').innerHTML=view==='next'?nextView():view==='materials'?materialView():questView();bind()}
function go(v){view=v;search='';filter='all';selectedRaid=null;render();window.scrollTo({top:0,behavior:'instant'})}
function bind(){document.querySelectorAll('[data-item-name]').forEach(el=>el.onclick=()=>openItemDetails(el.dataset.itemName,el));document.querySelectorAll('.supply-icon').forEach(img=>img.onerror=()=>img.remove());document.querySelectorAll('[data-objective-map]').forEach(el=>el.onclick=e=>{e.preventDefault();e.stopPropagation();openObjectiveMap(el.dataset.objectiveMap,+el.dataset.mapIndex,el)});if($('#reset-campaign'))$('#reset-campaign').onclick=()=>{try{openCampaignReset()}catch(e){notice(e.message)}};if($('#undo-quest'))$('#undo-quest').onclick=()=>{try{undoQuest()}catch(e){notice(e.message);render()}};if($('#finish-raid'))$('#finish-raid').onclick=e=>{try{finishDeployment(+e.currentTarget.dataset.number)}catch(err){notice(err.message);render()}};document.querySelectorAll('[data-quest]').forEach(el=>el.onchange=()=>{try{complete(el.dataset.quest,el.checked)}catch(e){notice(e.message);render()}});document.querySelectorAll('[data-objective]').forEach(el=>el.onchange=()=>{const id=el.dataset.objective,i=+el.dataset.index;if(!cloudReady||!unlocked(by[id])||(view==='next'&&selectedRaid))return;retainCurrentBrief();const a=new Set(state.objectives[id]||[]);el.checked?a.add(i):a.delete(i);state.objectives[id]=[...a];save();render()});document.querySelectorAll('[data-go]').forEach(el=>el.onclick=()=>go(el.dataset.go));document.querySelectorAll('[data-raid]').forEach(el=>el.onclick=()=>{selectedRaid=+el.dataset.raid;render()});if($('#raid-select'))$('#raid-select').onchange=e=>{selectedRaid=e.target.value==='auto'?null:+e.target.value;render()};document.querySelectorAll('[data-map]').forEach(el=>el.onclick=()=>{map=el.dataset.map;render()});if($('#quest-filter'))$('#quest-filter').onchange=e=>{filter=e.target.value;render()};for(const id of ['quest-search','material-search'])if($('#'+id))$('#'+id).oninput=e=>{const pos=e.target.selectionStart;search=e.target.value;render();const input=$('#'+id);input.focus();input.setSelectionRange(pos,pos)};document.querySelectorAll('[data-quantity]').forEach(el=>el.onchange=()=>{try{quantity(el.dataset.quantity,Number(el.value))}catch(e){notice(e.message);render()}});document.querySelectorAll('[data-step]').forEach(el=>el.onclick=()=>quantity(el.dataset.name,Math.max(0,(state.materials[el.dataset.name]||0)+Number(el.dataset.step))));document.querySelectorAll('[data-material-check]').forEach(el=>el.onchange=()=>{const m=data.materials.find(m=>m.name===el.dataset.materialCheck);quantity(m.name,el.checked?materialTarget(m):0)});document.querySelectorAll('[data-reward-use]').forEach(el=>el.onchange=()=>{try{if(!cloudReady)throw Error('Wait for your account progress to load.');const choices=new Set(state.rewardOptOut||[]);el.checked?choices.delete(el.dataset.rewardUse):choices.add(el.dataset.rewardUse);state.rewardOptOut=[...choices];save();render()}catch(e){notice(e.message);render()}})}
$('#reset-cancel').onclick=closeCampaignReset;$('#reset-proceed').onclick=()=>{try{resetCampaign()}catch(e){closeCampaignReset();notice(e.message)}};$('#campaign-reset').onclose=()=>{resetStorageKey=null};$('#campaign-reset').oncancel=()=>{resetStorageKey=null};
document.querySelectorAll('.nav').forEach(el=>el.onclick=()=>go(el.dataset.view));$('#guide-open').onclick=()=>$('#guide').showModal();$('#guide-close').onclick=()=>$('#guide').close();$('#export').onclick=()=>{const blob=new Blob([JSON.stringify({version:1,savedAt:new Date().toISOString(),...state},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='ARC_Mission_Control_Progress.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};$('#import').onchange=async e=>{try{if(!cloudReady)throw Error('Wait for account progress to load.');const file=e.target.files[0];if(!file)return;if(file.size>2000000)throw Error('Backup is too large');state=validState(JSON.parse(await file.text()));settleDeployment();selectedRaid=null;save();render();notice('Progress restored.')}catch(err){notice('Unable to restore: '+err.message)}finally{e.target.value=''}};
function registerTools(){const ctx=document.modelContext;if(!ctx?.registerTool)return;const controller=new AbortController();const tools=[{name:'get_campaign_progress',description:'Read completed quests, unlocked quests and recommended next deployment.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:()=>({completed:state.completed,unlocked:data.quests.filter(q=>!isDone(q.id)&&unlocked(q)).map(q=>({id:q.id,name:q.name})),nextRaid:nextRaid()})},{name:'set_quest_completion',description:'Mark a quest completed after in-game turn-in, or reopen it and its dependent quests.',inputSchema:{type:'object',properties:{questId:{type:'string'},completed:{type:'boolean'}},required:['questId','completed'],additionalProperties:false},annotations:{readOnlyHint:false},execute:i=>{if(typeof i?.questId!=='string'||typeof i?.completed!=='boolean')throw Error('Quest ID and completion boolean required');complete(i.questId,i.completed);return {questId:i.questId,completed:isDone(i.questId)}}},{name:'set_material_collected',description:'Set the current quantity of a quest material in the stash.',inputSchema:{type:'object',properties:{name:{type:'string'},quantity:{type:'integer',minimum:0,maximum:99999}},required:['name','quantity'],additionalProperties:false},annotations:{readOnlyHint:false},execute:i=>{quantity(i?.name,i?.quantity);return {name:i.name,quantity:state.materials[i.name],available:available(i.name)}}}];for(const t of tools)try{Promise.resolve(ctx.registerTool(t,{signal:controller.signal})).catch(()=>{})}catch{}window.addEventListener('pagehide',()=>controller.abort(),{once:true})}
Promise.resolve(ARCOffline.data).then(d=>{data=d;by=Object.fromEntries(d.quests.map(q=>[q.id,q]));state.objectiveVersion=d.objectiveVersion||0;try{const saved=localStorage.getItem(KEY);if(saved){state=validState(JSON.parse(saved));settleDeployment()}}catch{notice('Saved progress could not be loaded. Restore a backup from the tracker guide.')}render();window.arcTracker={read:()=>JSON.parse(JSON.stringify(state)),validate:validState,guestKey:KEY,key:()=>storageKey,replace:(s,key)=>{state=validState(s);settleDeployment();selectedRaid=null;storageKey=key;try{localStorage.setItem(storageKey,JSON.stringify(state))}catch{}render()},loading:(v)=>{cloudReady=!v;$('#main').classList.toggle('cloud-loading',v);$('#main').setAttribute('aria-busy',String(v))},announce:notice};window.dispatchEvent(new Event('arc-tracker-ready'))}).catch(e=>{$('#main').innerHTML=`<div class="empty">${esc(e.message)}. Reload this page to retry.</div>`});
