/**
 * dynamo-bao/remote: run named, versioned procedures next to DynamoDB and
 * call them from far away in one round trip.
 *
 * See tutorials/11-remote-procedures.md for the frozen contract
 * (ProcedureContext, Actor, outcome tags, replay classes).
 * @module dynamo-bao/remote
 */
const {
  defineProcedure,
  ProcedureRegistry,
  REPLAY_CLASSES,
  SCOPES,
} = require("./procedures");
const { createContext, fresh, bindModelsToTenant } = require("./context");
const { encodeValue, decodeRow, CodecError } = require("./codec");
const { createExecutor } = require("./executor");
const { remote, inProcess } = require("./client");
const { DetachedInstanceError } = require("../exceptions");

module.exports = {
  defineProcedure,
  ProcedureRegistry,
  REPLAY_CLASSES,
  SCOPES,
  createContext,
  fresh,
  bindModelsToTenant,
  encodeValue,
  decodeRow,
  CodecError,
  createExecutor,
  remote,
  inProcess,
  DetachedInstanceError,
};
