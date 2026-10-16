'use strict';
const {onCall,HttpsError}=require('firebase-functions/v2/https');
const {onSchedule}=require('firebase-functions/v2/scheduler');
const admin=require('firebase-admin');
const {initial,press,advance}=require('./engine');
admin.initializeApp();
const db=admin.database();
const path='dontPressButton/state';
exports.dpbJoin=onCall({region:'asia-northeast3',enforceAppCheck:false},async(request)=>{
 const uid=request.auth?.uid;
 if(!uid)throw new HttpsError('unauthenticated','익명 Firebase 인증이 필요합니다.');
 const nickname=String(request.data?.nickname||'').trim();
 if(nickname.length<2||nickname.length>12||/[<>\u0000-\u001f]/.test(nickname))throw new HttpsError('invalid-argument','닉네임은 2~12자로 입력하세요.');
 await db.ref(`dontPressButton/participants/${uid}`).set({nickname,joinedAt:admin.database.ServerValue.TIMESTAMP});
 return {nickname};
});
exports.dpbPress=onCall({region:'asia-northeast3'},async(request)=>{
 const uid=request.auth?.uid;
 if(!uid)throw new HttpsError('unauthenticated','인증이 필요합니다.');
 const user=(await db.ref(`dontPressButton/participants/${uid}`).get()).val();
 if(!user)throw new HttpsError('failed-precondition','먼저 입장하세요.');
 let accepted=false;
 await db.ref(path).transaction(current=>{
  const now=Date.now();
  const s=current||initial(now);
  const result=press(s,uid,user.nickname,now);
  accepted=result.accepted;
  return result.accepted?result.state:undefined;
 });
 return {accepted};
});
exports.dpbTick=onSchedule({schedule:'every 1 minutes',timeZone:'Asia/Seoul',region:'asia-northeast3'},async()=>{
 await db.ref(path).transaction(current=>{
  const now=Date.now();
  if(!current)return initial(now);
  let next=current;
  // A scheduler is a recovery fallback, not a precise real-time timer.
  for(let i=0;i<100&&now>=next.phaseEndsAt;i++)next=advance(next,next.phaseEndsAt);
  return next;
 });
});