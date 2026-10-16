'use strict';
const DURATIONS={playing:60000,failed:10000,succeeded:30000};
function initial(now=Date.now(),best=0){return {phase:'playing',attempt:1,round:1,phaseEndsAt:now+DURATIONS.playing,bestRecord:best,lastPresser:null,lastSuccessAttempts:null};}
function press(state,uid,nickname,now=Date.now()){
 if(state.phase!=='playing'||now>=state.phaseEndsAt)return {state,accepted:false};
 return {accepted:true,state:{...state,phase:'failed',phaseEndsAt:now+DURATIONS.failed,lastPresser:{uid,nickname},attempt:state.attempt}};
}
function advance(state,now=Date.now()){
 if(now<state.phaseEndsAt)return state;
 if(state.phase==='playing')return {...state,phase:'succeeded',phaseEndsAt:now+DURATIONS.succeeded,bestRecord:Math.max(state.bestRecord,state.attempt),lastSuccessAttempts:state.attempt,lastPresser:null};
 if(state.phase==='failed')return {...state,phase:'playing',attempt:state.attempt+1,phaseEndsAt:now+DURATIONS.playing,lastPresser:null};
 if(state.phase==='succeeded')return {...state,phase:'playing',attempt:1,round:state.round+1,phaseEndsAt:now+DURATIONS.playing,lastPresser:null};
 throw new Error('Unknown phase');
}
module.exports={DURATIONS,initial,press,advance};