import assert from 'node:assert/strict';
import test from 'node:test';
import {parseAnnotationDoneContext,annotationDoneContextKey} from '../src/annotation-done-context.ts';
const context={paneId:1,paneLineageId:'actual-lineage',contentId:'content',revision:2,renderVersion:3};
test('completion context is copied and includes lineage, content revision and render identity',()=>{
 const parsed=parseAnnotationDoneContext(context);assert.deepEqual(parsed,context);assert.notEqual(parsed,context);
 for(const [key,value] of [['paneId',2],['paneLineageId','replacement'],['contentId','new'],['revision',3],['renderVersion',4]])
  assert.notEqual(annotationDoneContextKey({...context,[key]:value}),annotationDoneContextKey(context));
});
test('numeric coercions, missing ownership and nonfinite render identity are refused',()=>{
 for(const patch of [{paneId:'1'},{paneId:0},{paneLineageId:''},{paneLineageId:undefined},{revision:'2'},{revision:-1},{renderVersion:NaN},{contentId:undefined}])
  assert.equal(parseAnnotationDoneContext({...context,...patch}),null);
});
