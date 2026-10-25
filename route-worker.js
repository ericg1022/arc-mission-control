'use strict';

onmessage=event=>{
 try{
  const {data,saved,current,prior}=event.data,p=ARCPlanner.create(data);
  // Route search runs off the UI thread and reports each better route. The
  // app keeps the best complete route, so improvements build up across visits.
  const best=p.search(saved,current,{prior,timeLimit:15000,onImprove:plan=>postMessage({plan,final:false})});
  postMessage({plan:best,final:true});
 }catch{postMessage({error:true,final:true});}
};
