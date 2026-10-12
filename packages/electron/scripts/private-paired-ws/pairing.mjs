import assert from 'node:assert/strict';
import {SURF_ACE_LOCKLESS_V1_CAPABILITY,validateLocklessEnvelope} from '../../../protocol/src/lockless.ts';
export const CONTROLLERS=['primary','unpaired','egress','deadline','disconnect','timeout'];
export function controllerId(label){assert(CONTROLLERS.includes(label));return `private-scope-b-${label}`;}
export function pairPayload(label,surfaceId){return {controllerInstanceId:controllerId(label),controllerProductName:'OpenClaw',projectionCapacityBytes:8*1024*1024,protocolFeatures:[SURF_ACE_LOCKLESS_V1_CAPABILITY],protocolVersion:1,surfaceId};}
export function validPairReceipt(pair,label,surfaceId){assert.equal(pair.q.op,'pair.request');assert.deepEqual(pair.q.payload,pairPayload(label,surfaceId));assert(validateLocklessEnvelope(pair.q).ok);assert(validateLocklessEnvelope(pair.r).ok);assert.equal(pair.r.ok,true);assert.equal(pair.r.payload.controllerInstanceId,controllerId(label));assert.equal(pair.r.payload.surfaceId,surfaceId);}
