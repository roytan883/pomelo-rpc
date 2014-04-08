var EventEmitter = require('events').EventEmitter;
var util = require('util');
var utils = require('../../util/utils');
var ws = require('ws').Server;
var logger = require('pomelo-logger').getLogger('pomelo-rpc', __filename);
var Tracer = require('../../util/tracer');

var Acceptor = function(opts, cb){
  EventEmitter.call(this);
  this.bufferMsg = opts.bufferMsg;
  this.interval = opts.interval;  // flush interval in ms
  this.rpcDebugLog = opts.rpcDebugLog;
  this.rpcLogger = opts.rpcLogger;
  this.whitelist = opts.whitelist;
  this._interval = null;          // interval object
  this.sockets = {};
  this.msgQueues = {};
  this.cb = cb;
};
util.inherits(Acceptor, EventEmitter);

var pro = Acceptor.prototype;

var gid = 1;

pro.listen = function(port) {
  //check status
  if(!!this.inited) {
    utils.invokeCallback(this.cb, new Error('already inited.'));
    return;
  }
  this.inited = true;

  var self = this;

  this.server = new ws({port: port});

  this.server.on('error', function(err) {
    self.emit('error', err);
  });

  this.server.on('connection', function(socket) {
    var id = gid++;
    self.sockets[id] = socket;

    self.emit('connection', {id: id, ip: socket._socket.remoteAddress});

    socket.on('message', function(data, flags) {
      try {
        var msg;
        if(flags.binary){
          console.warn("ws rpc server received binary message, not support!!!");
          return;
        }
        else{
          console.log("ws rpc server received message = " + data);
          msg = data;
        }

        msg = JSON.parse(msg);

        if(msg.body instanceof Array) {
          processMsgs(socket, self, msg.body);
        } else {
          processMsg(socket, self, msg.body);
        }
      } catch(e) {
        console.error('ws rpc server process message with error: %j', e.stack);
      }
    });

    socket.on('close', function(code, message) {
      delete self.sockets[id];
      delete self.msgQueues[id];
    });
  });

  this.on('connection', ipFilter.bind(this));

  if(this.bufferMsg) {
    this._interval = setInterval(function() {
      flush(self);
    }, this.interval);
  }
};

var ipFilter = function(obj) {
  if(typeof this.whitelist === 'function') {
    var self = this;
    self.whitelist(function(err, tmpList) {
      if(err) {
        logger.error('%j.(RPC whitelist).', err);
        return;
      }
      if(!Array.isArray(tmpList)) {
        logger.error('%j is not an array.(RPC whitelist).', tmpList);
        return;
      }
      if(!!obj && !!obj.ip && !!obj.id) {
        for(var i in tmpList) {
          var exp = new RegExp(tmpList[i]);
          if(exp.test(obj.ip)) {
            return;
          }
        }
        var sock = self.sockets[obj.id];
        if(sock) {
          sock.close();
          logger.warn('%s is rejected(RPC whitelist).', obj.ip);
        }
      }
    });
  }
};

pro.close = function() {
  if(!!this.closed) {
    return;
  }
  this.closed = true;
  if(this._interval) {
    clearInterval(this._interval);
    this._interval = null;
  }
  try {
    this.server.close();
  } catch(err) {
    console.error('rpc server close error: %j', err.stack);
  }
  this.emit('closed');
};

var cloneError = function(origin) {
  // copy the stack infos for Error instance json result is empty
  var res = {
    msg: origin.msg,
    stack: origin.stack
  };
  return res;
};

var processMsg = function(socket, acceptor, pkg) {
  var tracer = new Tracer(acceptor.rpcLogger, acceptor.rpcDebugLog, pkg.remote, pkg.source, pkg.msg, pkg.traceId, pkg.seqId);
  tracer.info('server', __filename, 'processMsg', 'ws-acceptor receive message and try to process message');
  acceptor.cb.call(null, tracer, pkg.msg, function() {
    var args = Array.prototype.slice.call(arguments, 0);
    for(var i=0, l=args.length; i<l; i++) {
      if(args[i] instanceof Error) {
        args[i] = cloneError(args[i]);
      }
    }
    var resp;
    if(tracer.isEnabled) {
      resp = {traceId: tracer.id, seqId: tracer.seq, source: tracer.source, id: pkg.id, resp: Array.prototype.slice.call(args, 0)};
    }
    else {
      resp = {id: pkg.id, resp: Array.prototype.slice.call(args, 0)};
    }
    if(acceptor.bufferMsg) {
      enqueue(socket, acceptor, resp);
    } else {
      socket.send(JSON.stringify({body: resp}));
    }
  });
};

var processMsgs = function(socket, acceptor, pkgs) {
  for(var i=0, l=pkgs.length; i<l; i++) {
    processMsg(socket, acceptor, pkgs[i]);
  }
};

var enqueue = function(socket, acceptor, msg) {
  var queue = acceptor.msgQueues[socket.id];
  if(!queue) {
    queue = acceptor.msgQueues[socket.id] = [];
  }
  queue.push(msg);
};

var flush = function(acceptor) {
  var sockets = acceptor.sockets, queues = acceptor.msgQueues, queue, socket;
  for(var socketId in queues) {
    socket = sockets[socketId];
    if(!socket) {
      // clear pending messages if the socket not exist any more
      delete queues[socketId];
      continue;
    }
    queue = queues[socketId];
    if(!queue.length) {
      continue;
    }
    socket.send(JSON.stringify({body: queue}));
    queues[socketId] = [];
  }
};

/**
 * create acceptor
 *
 * @param opts init params
 * @param cb(tracer, msg, cb) callback function that would be invoked when new message arrives
 */
module.exports.create = function(opts, cb) {
  return new Acceptor(opts || {}, cb);
};
