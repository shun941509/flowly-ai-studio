import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePredicate, parsePredicate } from "../domain/predicate";
test("typed comparisons reject coercion and missing paths and preserve boundary equality", () => {
  const predicate = {path:"data.amount",operator:"gte",rightPath:"data.limit"} as const;
  assert.equal(evaluatePredicate(predicate,{data:{amount:10,limit:10}}),true);
  assert.equal(evaluatePredicate(predicate,{data:{amount:9,limit:10}}),false);
  assert.throws(()=>evaluatePredicate(predicate,{data:{amount:"10",limit:10}}));
  assert.throws(()=>evaluatePredicate(predicate,{data:{amount:10}}));
  assert.equal(evaluatePredicate({path:"flag",operator:"eq",value:1},{flag:true}),false);
  assert.throws(()=>parsePredicate({path:"__proto__.x",operator:"eq",value:1}));
  assert.throws(()=>parsePredicate({...predicate,value:1}));
  assert.throws(()=>parsePredicate({path:"x",operator:"eq",value:Infinity}));
});
