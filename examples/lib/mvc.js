/**  Simple MVC framework 
  *
  *  redis pubsub built in
  *  automatically loads views
  *  automatically loads view rendering engine
  */

var _ = require('underscore'),
emitter = require('events').EventEmitter,
fs = require('fs'),
hash = require('hashish'),
redis = require('redis');

var walk = function(dir, done) {
    var results = {};
    fs.readdir(dir, function(err, list) {
        if (err) return done(err);
        var pending = list.length;
        list.forEach(function(file) {  
          file = dir + '/' + file;     
          fs.stat(file, function(err, stat) {
            if (stat && stat.isDirectory()) {
              walk(file, function(err, res) {
                var key = file.replace(/^.*\//, '');
                _.extend(results, res);
                if (!--pending) done(null, results);
              });
            } else {
              var str = fs.readFileSync(file, 'utf-8');
              var key = file.replace(/^.*\//, '');
              key = key.match(/(.*)\.[^.]+$/);
              key = key[1];
              results[key] = str;
              if (!--pending) done(null, results);
            }
          });
        });
    });
};

exports.database = 'memory';
exports.templates = [];
exports['template engine'] = 'mustache';

exports.set = function () {
    if (typeof arguments[0] !== 'string') return;
    var key = arguments[0];
    var value = arguments[1];
    var params = arguments[2];
    switch (key) {
    
        case 'database':
            if (exports.debug) console.log('setting database', value);
            exports.database = value;
            exports.db = require(value);
            if (value === 'redis') exports.db = exports.db.createClient();
            if (value === 'mongodb') exports.db = exports.db.connect();
        break;
        
        case 'template engine':
            if (exports.debug) console.log('setting template engine', value);
            exports['template engine'] = value;
            exports[value] = require(value);
            exports.render = exports[value].render;
        break;
        
        case 'templates directory':
            if (exports.debug) console.log('setting templates directory', value);
            var dir = arguments[1] || 'views';
            walk('./' + dir, function (e, tpls) {
                tpls = tpls || [];
                if (exports.debug) console.log('Loaded ' + Object.keys(tpls).length + ' views from ' + dir);
                exports.templates = tpls;
            });
        break;
        
    }
};

exports.middleware = pubsub = function (client, conn) {
    conn.on('end', function () {
		
		if (conn.stream && conn.id && exports.middleware.clients[conn.stream]) {
		    delete exports.middleware.clients[conn.stream][conn.id];
		}
		
		if (conn.stream) {
		    redisSub.unsubscribe(conn.stream);
		}
		
    });
};

exports.middleware.clients = {};
exports.redisPub = redisPub = redis.createClient();
exports.redisSub = redisSub = redis.createClient();

redisSub.on('message', function(stream, data) {
    new hash(exports.middleware.clients[stream]).forEach(function (emit) {
        emit.call({}, JSON.parse(data));
    });
});

exports.redisPubSub = function (conn, model) {
    if(!exports.middleware.clients[conn.stream]) {
        exports.middleware.clients[conn.stream] = {};
    }

    exports.middleware.clients[conn.stream][conn.id] = model.sync;
    exports.redisSub.subscribe(conn.stream);
};

exports.Model = function (params) {
    params = _.extend({}, params, this);
    this.property = this.model + '_';
    this.collection = [];
    var self = this;
    _.extend(this, new emitter, {
    
        comparator: function (collection) {
            return _.sortBy(collection, function (v) {
                var proplen = self.property.length+1;
                var foo = v.id.slice(proplen);
                return Math.abs(foo);
            });
        },
        
        add: function (doc) {
            self.create(doc);
        },
        
        create: function (doc) {
            doc.id = doc.id || _.uniqueId(self.property);
            if (!doc.name) return;
            exports.db.get(self.model, function (e, collection) {
                if (e) console.log(e);                
                collection = JSON.parse(collection); 
                collection.push(doc);
                collection = JSON.stringify(collection);
                exports.db.set(self.model, collection, function (e) {
                    self.emit('add', doc);
                    redisPub.publish(self.model, collection);
                });
            });
        },
        
        read: function (fn) {
            exports.db.get(self.model, function (e, collection) {
                fn(JSON.parse(collection));
            });
        },
        
        update: function (doc) {
            if (!doc.name) return;
            exports.db.get(self.model, function (e, collection) {
                collection = _.reject(JSON.parse(collection), function (itm) {
                    return (itm.id === doc.id);
                });
                collection.push(doc);
                collection = JSON.stringify(collection);
                exports.db.set(self.model, collection, function (e) {
                    self.emit('change', collection);
                    redisPub.publish(self.model, collection);
                });
            });
        },
        
        remove: function (ids) {
            exports.db.get(self.model, function (err, collection) {
                if (typeof ids === 'undefined') return;
                if (typeof ids === 'string') ids = [].concat(ids);
                collection = _.filter(JSON.parse(collection), function (itm) { 
                    if (_.indexOf(ids, itm.id) < 0) {
                        return true;
                    } else {
                        self.emit('remove', itm);
                        return false;
                    }
                });
                collection = JSON.stringify(collection);
                exports.db.set(self.model, collection);
                redisPub.publish(self.model, collection);
            });
        },
        
        sync: function (newdocs) {
            if (!newdocs) return;
            newdocs = self.comparator(newdocs);
            
            var ids = _.pluck(self.collection, 'id');
            for (var i=0, l=newdocs.length;i<l;i++) {
                var id = newdocs[i].id;
                var exist = _.include(ids, id);
                if (!exist) {
                    //self.collection.push(newdocs[i]);
                    self.emit('initialize', newdocs[i]);
                    self.initialize && self.initialize(newdocs[i]);
                }
                
            }
            
            var ids = _.pluck(newdocs, 'id');
            for (var i=0, l=self.collection.length;i<l;i++) {
                var item = self.collection[i];
                var exist = _.include(ids, item.id);
                if (!exist) {
                    self.emit('remove', item);
                }
                
            }
                
            self.collection = newdocs;
            self.emit('sync', self.collection);
        }
        
    });
    return this;

};

exports.View = function (params) {
    _.extend(this, new emitter, {
        'templates': exports.templates
    });
    this.initialize && this.initialize(params);
    this.emit('initialize', params);
    return this;
};

exports.Controller = function (params) {
    _.extend(this, new emitter);
    this.initialize && this.initialize(params);
    this.emit('initialize', params);
    return this;
};

exports.Model.extend = function (params) {
    return function (opts) {
        return exports.Model.call(params, opts);
    }
};

exports.View.extend = function (params) {
    return function (opts) {
        return exports.View.call(params, opts);
    }
};

exports.Controller.extend = function (params) {
    return function (opts) {
        return exports.Controller.call(params, opts);
    }
};
