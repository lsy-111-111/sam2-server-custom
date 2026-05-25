/**
 * @generated SignedSource<<f982194ec3e25b5f84172636b601586c>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type AddPointsBatchInput = {
  clearOldPoints: boolean;
  frameIndex: number;
  objects: ReadonlyArray<AddPointsBatchObjectInput>;
  sessionId: string;
};
export type AddPointsBatchObjectInput = {
  labels: ReadonlyArray<number>;
  objectId: number;
  points: ReadonlyArray<ReadonlyArray<number>>;
};
export type SAM2ModelAddNewPointsBatchMutation$variables = {
  input: AddPointsBatchInput;
};
export type SAM2ModelAddNewPointsBatchMutation$data = {
  readonly addPointsBatch: {
    readonly frameIndex: number;
    readonly rleMaskList: ReadonlyArray<{
      readonly objectId: number;
      readonly rleMask: {
        readonly counts: string;
        readonly size: ReadonlyArray<number>;
      };
    }>;
  };
};
export type SAM2ModelAddNewPointsBatchMutation = {
  response: SAM2ModelAddNewPointsBatchMutation$data;
  variables: SAM2ModelAddNewPointsBatchMutation$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "input"
  }
],
v1 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "input",
        "variableName": "input"
      }
    ],
    "concreteType": "RLEMaskListOnFrame",
    "kind": "LinkedField",
    "name": "addPointsBatch",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "frameIndex",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "RLEMaskForObject",
        "kind": "LinkedField",
        "name": "rleMaskList",
        "plural": true,
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "objectId",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "concreteType": "RLEMask",
            "kind": "LinkedField",
            "name": "rleMask",
            "plural": false,
            "selections": [
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "counts",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "size",
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
        "storageKey": null
      }
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "SAM2ModelAddNewPointsBatchMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "SAM2ModelAddNewPointsBatchMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "6a633f695377377968777786cd6d8f88",
    "id": null,
    "metadata": {},
    "name": "SAM2ModelAddNewPointsBatchMutation",
    "operationKind": "mutation",
    "text": "mutation SAM2ModelAddNewPointsBatchMutation(\n  $input: AddPointsBatchInput!\n) {\n  addPointsBatch(input: $input) {\n    frameIndex\n    rleMaskList {\n      objectId\n      rleMask {\n        counts\n        size\n      }\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "b885f5de461d8e31d435912383dbdb3c";

export default node;
