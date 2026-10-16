import {CODES} from './morse.js';
export const CHARACTERS='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const WORDS=Object.freeze(['RADIO','MORSE','HELLO','WORLD','SIGNAL','CODE','WAVE','ANTENNA','POWER','TRAIN','LEARN','SOUND','LIGHT','NIGHT','GREEN','BLUE','WATER','EARTH','SPACE','STAR','MOON','SUN','WIND','RAIN','SNOW','FIRE','TREE','BIRD','HOME','FIELD','RIVER','OCEAN','HAPPY','THANKS','READY','CLEAR','GOOD','TEST','CALL','SEND','COPY','ROGER','TOWER','BEAM','TONE','KEY','TIME','SHORT','LONG','QUIET']);
export const SYMBOLS=Object.keys(CODES).filter(c=>!/[A-Z0-9]/.test(c)).join('');
export function promptPool(categories=['letter','digit']){
 const groups={letter:'ABCDEFGHIJKLMNOPQRSTUVWXYZ',digit:'0123456789',symbol:SYMBOLS};
 const pool=[...new Set(categories.flatMap(key=>[...(groups[key]??'')]))];
 if(!pool.length)throw new Error('请至少选择字母、数字或符号中的一项。');
 return pool;
}



export const BANK_FILES=Object.freeze({qcode:'qcodes.txt',cw:'cw_terms.txt',sentence:'sentences.txt'});
export function parsePracticeBank(text){
 const entries={};
 text.replace(/^\uFEFF/,'').split(/\r?\n/).forEach((raw,index)=>{
  const line=raw.trim();if(!line||line.startsWith('#'))return;
  const separator=line.indexOf('|');
  const content=line.slice(0,separator).trim().toUpperCase().replace(/\s+/g,' '),meaning=line.slice(separator+1).trim();
  if(separator<1||!meaning||[...content].some(c=>c!==' '&&!CODES[c]))throw new Error(`第 ${index+1} 行格式错误，请使用“发送内容 | 中文含义”，发送内容仅支持字母、数字及已支持的摩尔斯符号。`);
  entries[content]=meaning;
 });
 if(!Object.keys(entries).length)throw new Error('题库为空，请至少填写一行“发送内容 | 中文含义”。');
 return entries;
}
export function parseCallsigns(text){
 const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).map(s=>s.trim().toUpperCase()).filter(Boolean);
 const invalid=lines.filter(s=>! /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/.test(s)||s.length>32);
 return {callsigns:[...new Set(lines.filter(s=>!invalid.includes(s)))],invalid};
}
export function nextPrompt(mode,previous='',random=Math.random,categories=['letter','digit'],callsigns=[],banks={}){
 const bank=mode==='character'?promptPool(categories):mode==='word'?WORDS:mode==='callsign'?callsigns:Object.keys(banks[mode]??{});
 if(!bank.length)throw new Error(mode==='callsign'?'没有可用呼号，请在项目目录的 callsign.txt 中每行填写一个呼号，再重新读取。':`没有可用题目，请检查 ${BANK_FILES[mode]||'题库'}。`);
 const remaining=bank.filter(item=>item!==previous),choices=remaining.length?remaining:bank;
 return choices[Math.min(choices.length-1,Math.max(0,Math.floor(random()*choices.length)))];
}
// Silence of three dots ends the current character. A word ends when enough
// characters have been sent; errors still advance, so this is not a pass gate.
export function questionComplete(practice,now){
 return !practice.finished&&practice.downAt===null&&practice.lastEnd!==null&&now-practice.lastEnd>=practice.lesson.unit*3&&practice.received(now).length>=practice.lesson.letters.length;
}
export function retentionMs(value){
 const n=Number(value);return Math.min(30,Math.max(0,Number.isFinite(n)?n:1.5))*1000;
}
export function reviewReady({reviewAt,now,holdSeconds,lastEdgeAt,unit,released}){
 return reviewAt!==null&&released&&now-reviewAt>=retentionMs(holdSeconds)&&now-lastEdgeAt>=unit*3;
}
