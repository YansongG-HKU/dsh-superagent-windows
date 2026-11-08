import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireStateLock } from '../src/app/state-lock.ts'

const opts = (signal = new AbortController().signal) => ({signal,timeoutMs:200,retryMs:20,onCompromised:(error:Error)=>{throw error}})
describe('startup state lock recovery',()=>{
 it('waits asynchronously until the owner releases without stealing its lock',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dsh-lock-'));let release:(()=>Promise<void>)|undefined
  try{const first=await acquireStateLock(dir,opts());let tick=false;setTimeout(()=>{tick=true;void first()},40);release=await acquireStateLock(dir,opts());expect(tick).toBe(true)}finally{await release?.();await rm(dir,{recursive:true,force:true})}
 })
 it('times out while an active owner keeps its lease',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dsh-lock-'));const release=await acquireStateLock(dir,opts())
  try{await expect(acquireStateLock(dir,opts())).rejects.toThrow('deadline')}finally{await release();await rm(dir,{recursive:true,force:true})}
 })
 it('cancels a queued acquisition and leaves the owner releasable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dsh-lock-'));const release=await acquireStateLock(dir,opts());const c=new AbortController();setTimeout(()=>c.abort(),30)
  try{await expect(acquireStateLock(dir,opts(c.signal))).rejects.toThrow()}finally{await release();await rm(dir,{recursive:true,force:true})}
 })
 it('recovers a genuinely stale abandoned lock',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dsh-lock-'));await mkdir(dir+'.lock');const old=new Date(Date.now()-60000);await utimes(dir+'.lock',old,old);let release:(()=>Promise<void>)|undefined
  try{release=await acquireStateLock(dir,opts());expect(release).toBeTypeOf('function')}finally{await release?.();await rm(dir,{recursive:true,force:true})}
 })
})
