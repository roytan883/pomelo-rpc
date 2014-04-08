//var acceptor = require('./acceptors/ws-acceptor');
var acceptor = require('./acceptors/websocket-acceptor');
module.exports.create = function(opts, cb) {
  return acceptor.create(opts, cb);
};