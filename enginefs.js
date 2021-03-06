var url = require("url");
var os = require("os");
var events = require("events");
var path = require("path");
var util = require("util");

var connect = require("connect");
var rangeParser = require("range-parser");
var bodyParser = require("body-parser");
var Router = require("router");

var mime = require("mime");
var pump = require("pump");

var PeerSearch = require("peer-search");

var async = require("async");

var EngineFS =  new events.EventEmitter();

var Counter = require("./lib/refcounter");

// Events:
// stream-open
// stream-close
// stream-inactive stream-inactive:hash:idx

// stream-cached stream-cached:hash:idx
// stream-progress stream-progress:hash:idx
 
// engine-create
// engine-created

// engine-active
// engine-idle
// engine-inactive

// TODO Provide option for those to be changed
EngineFS.STREAM_TIMEOUT = 30*1000; // how long must a stream be unused to be considered 'inactive'
EngineFS.ENGINE_TIMEOUT = 60*1000; 

var engines = { };

EngineFS.getDefaults = function(ih) {
    return {
        peerSearch: { min: 40, max: 200, sources: [ "dht:"+ih ] },
        dht: false, tracker: false, // LEGACY ARGS, disable because we use peerSearch
    }
};

EngineFS.getCachePath = function(ih) {
    return path.join(os.tmpdir(), ih);
};

function createEngine(infoHash, options, cb)
{
    if (! EngineFS.engine) throw new Error("EngineFS requires EngineFS.engine to point to engine constructor");

    if (typeof(options) === "function") { cb = options; options = null; }
    cb = cb || function() { };
    EngineFS.once("engine-ready:"+infoHash, function() { cb(null, engines[infoHash]) });

    options = util._extend(EngineFS.getDefaults(infoHash), options || { });
    options.path = options.path || EngineFS.getCachePath(infoHash);

    Emit(["engine-create", infoHash, options]);
    
    var torrent = options.torrent || "magnet:?xt=urn:btih:"+infoHash;

    var isNew = !engines[infoHash];
    var e = engines[infoHash] = engines[infoHash] || EngineFS.engine(torrent, options);
    e.swarm.resume(); // In case it's paused

    if (isNew && options.peerSearch) new PeerSearch(options.peerSearch.sources, e.swarm, options.peerSearch);
    if (isNew && options.swarmCap) {
     var updateSwarmCap = function() {
         var unchoked = e.swarm.wires.filter(function(peer) { return !peer.peerChoking }).length;
         if (e.swarm.downloadSpeed() > options.swarmCap.maxSpeed && unchoked > options.swarmCap.minPeers) e.swarm.pause();
         else e.swarm.resume();
     };
     e.swarm.on("wire", updateSwarmCap);
     e.swarm.on("wire-disconnect", updateSwarmCap);
     e.on("download", updateSwarmCap);
    }
    if (options.growler && e.setFloodedPulse) e.setFloodedPulse(options.growler.flood, options.growler.pulse);
    
    if (isNew) e.on("error", function(err) { EngineFS.emit("engine-error:"+infoHash, err); EngineFS.emit("engine-error", infoHash, err); });
    
    if (isNew) Emit(["engine-created", infoHash]);
    e.ready(function() { EngineFS.emit("engine-ready:"+infoHash, e.torrent); EngineFS.emit("engine-ready", infoHash, e.torrent); })
}

function getEngine(infoHash) 
{
    return engines[infoHash.toLowerCase()]; 
}

function existsEngine(infoHash)
{
    return !!engines[infoHash.toLowerCase()]; 
}

function removeEngine(infoHash)
{
    if (!engines[infoHash]) return;
    engines[infoHash].destroy(function() { Emit(["engine-destroyed", infoHash]) });
    delete engines[infoHash];
}

function settingsEngine(infoHash, settings) 
{
   var e = engines[infoHash];
   if (!e) return;
   if (settings.hasOwnProperty("writeQueue") && e.store.writequeue) e.ready(function() {
        if (settings.writeQueue == "PAUSE") { 
            e.store.writequeue.pause(); 
            setTimeout(function() { e.store.writequeue.resume() }, 50*1000); // Done for safety reasons
        }
        else e.store.writequeue.resume(); // no need for ready, since it's by default resumed
   });
   
   if (settings.swarm == "PAUSE") e.swarm.pause();
   if (settings.swarm == "RESUME") e.swarm.resume();
}

function statsEngine(infoHash, idx)
{
    if (!engines[infoHash]) return null;
    return getStatistics(engines[infoHash], idx);
}

function listEngines()
{
    return Object.keys(engines);
}

var router = Router();
var externalRouter = Router();

// Emulate opening a stream
function prewarmStream(hash, idx)
{
    //EngineFS.emit("stream-open", hash, idx);
    if (engines[hash]) engines[hash].ready(function() { engines[hash].files[idx].select() }); // select without priority so we start downloading
};

function openPath(path, cb)
{
    // length: 40 ; info hash
    var parts = path.split("/").filter(function(x) { return x });
    if (parts[0] && parts[0].length == 40)
    {
        var infoHash = parts[0].toLowerCase();
        var i = Number(parts[1]);

        if (isNaN(i)) return cb(new Error("Cannot parse path: info hash received, but invalid file index"));
        
        createEngine(infoHash, function(err, engine)
        {
            if (err) return cb(err);
            if (! engine.files[i]) return cb(new Error("Torrent does not contain file with index "+i));
            
            cb(null, engine.files[i], engine);
        });
        return;
    }
    
    // length: 64 ; Linvo Hash ; TODO
    if (parts[0] && parts[0].length == 64)
    {
        /* Large TODO
         */
        return cb(new Error("Not implemented yet"));
    }
    
    cb(new Error("Cannot parse path"));
}

/* Basic routes
 */
var jsonHead = { "Content-Type": "application/json" };
router.get("/favicon.ico", function(req, res) { res.writeHead(404, jsonHead); res.end() });
router.get("/:infoHash/stats.json", function(req, res) { res.writeHead(200, jsonHead); res.end(JSON.stringify(getStatistics(engines[req.params.infoHash]))) });
router.get("/:infoHash/:idx/stats.json", function(req, res) { res.writeHead(200, jsonHead); res.end(JSON.stringify(getStatistics(engines[req.params.infoHash], req.params.idx))) });
router.get("/stats.json", function(req, res) { 
    res.writeHead(200, jsonHead);
    var stats = { };
    for (ih in engines) stats[ih] = getStatistics(engines[ih]);
    res.end(JSON.stringify(stats)); 
});

router.post("/:infoHash/create", function(req, res) {
    var ih = req.params.infoHash.toLowerCase();
    createEngine(ih, req.body, function() {
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify(getStatistics(engines[ih])));
    });
});
router.get("/:infoHash/remove", function(req, res) { 
 removeEngine(req.params.infoHash); 
 res.writeHead(200, jsonHead); res.end(JSON.stringify({})); 
});
router.get("/removeAll", function(req, res) { 
  for (ih in engines) removeEngine(ih);
  res.writeHead(200, jsonHead); res.end(JSON.stringify({})); 
});

router.get("/:infoHash/:idx", sendCORSHeaders, sendDLNAHeaders, function(req, res, next) {
    var u = url.parse(req.url, true);
    openPath(u.pathname, function(err, handle, e)
    {
        if (err) { console.error(err); res.statusCode = 500; return res.end(); }
        
        // Handle LinvoFS events
        EngineFS.emit("stream-open", e.infoHash, e.files.indexOf(handle));

        var closed = false;
        var emitClose = function() { 
            if (closed) return;
            closed = true;
            EngineFS.emit("stream-close", e.infoHash, e.files.indexOf(handle));
        };
        res.on("finish", emitClose);
        res.on("close", emitClose);

        req.connection.setTimeout(24*60*60*1000);
        //req.connection.setTimeout(0);

        var range = req.headers.range;
        range = range && rangeParser(handle.length, range)[0];
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Type", mime.lookup(handle.name));
        res.setHeader("Cache-Control", "max-age=0, no-cache");
        res.setHeader("Content-Disposition", 'attachment; filename="'+handle.name.replace(/"/, '\\"')+'"');
        if (u.query.subtitles) res.setHeader("CaptionInfo.sec", u.query.subtitles);

        //res.setHeader("Access-Control-Max-Age", "1728000");
        
        var opts = { };
        if (req.headers["enginefs-prio"]) opts.priority = parseInt(req.headers["enginefs-prio"]) || 1;

        if (!range) {
            res.setHeader("Content-Length", handle.length);
            if (req.method === "HEAD") return res.end();
            pump(handle.createReadStream(opts), res);
            return;
        }

        res.statusCode = 206;
        res.setHeader("Content-Length", range.end - range.start + 1);
        res.setHeader("Content-Range", "bytes "+range.start+"-"+range.end+"/"+handle.length);

        if (req.method === "HEAD") return res.end();
        pump(handle.createReadStream(util._extend(range, opts)), res);  
    });
});

/* Front-end: HTTP
 */
function createServer(port)
{
    var http = require("http");
    var app = connect();

    app.use(function(req, res, next) { 
        util._extend(req, url.parse(req.url, true));
        if (EngineFS.loggingEnabled) console.log("-> "+req.method+" "+url.parse(req.url).path+" "+(req.headers["range"] || "")); next();
    });

    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(externalRouter);
    app.use(router);

    var server = http.createServer(app);
    if (port) server.listen(port);
    return server;
};

function sendCORSHeaders(req, res, next)
{
    // Allow CORS requests to specify byte ranges.
    // The `Range` header is not a "simple header", thus the browser
    // will first send OPTIONS request and check Access-Control-Allow-Headers
    // before allowing additional requests.

    if (req.method === 'OPTIONS' && req.headers.origin) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Range');
        res.setHeader('Access-Control-Max-Age', '1728000');

        res.end();
        return true;
    }

    if(req.headers.origin) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    }

    if (next) next();
} 

function sendDLNAHeaders(req, res, next)
{
    res.setHeader("transferMode.dlna.org", "Streaming");
    res.setHeader("contentFeatures.dlna.org", "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=017000 00000000000000000000000000");
   
    if (next) next();
}

/* Front-end: FUSE
 */
// TODO


function getStatistics(e, idx)
{
    if (!e) return null;
    var s = {
        infoHash: e.infoHash,

        peers: e.swarm.wires.length,
        unchoked: e.swarm.wires.filter(function(peer) { return !peer.peerChoking }).length,
        queued: e.swarm.queued,
        unique: Object.keys(e.swarm._peers).length,

        connectionTries: e.swarm.tries,
        paused: e.swarm.paused,
        swarmPaused: e.swarm.paused,

        selections: e.selection,
        wires: idx!==undefined ? null : e.swarm.wires.filter(function(peer) { return !peer.peerChoking }).map(function(wire) { 
           return { 
              requests: wire.requests.length, address: wire.peerAddress,
              amInterested: wire.amInterested, isSeeder: wire.isSeeder,
              downSpeed:  wire.downloadSpeed(), upSpeed: wire.uploadSpeed()
           } 
        }),

        files: e.torrent && e.torrent.files,

        downloaded: e.swarm.downloaded,
        uploaded: e.swarm.uploaded,

        downloadSpeed: e.swarm.downloadSpeed(),
        uploadSpeed: e.swarm.downloadSpeed(),
        
        sources: e.swarm.peerSearch && e.swarm.peerSearch.stats(),
        
        dht: !!e.dht,
        dhtPeers: e.dht ? Object.keys(e.dht.peers).length : null,
        dhtVisited: e.dht ? Object.keys(e.dht.visited).length : null
    };
    // TODO: better stream-specific data; e.g. download/uploaded should only be specific to this stream
    if (!isNaN(idx) && e.torrent && e.torrent.files[idx]) {
        s.streamLen = e.torrent.files[idx].length;
        s.streamName = e.torrent.files[idx].name;
    };
    return s;
}


/*
* Emit events
* stream-cached:fileID filePath file
* stream-progress:fileID filePath percent 
*/
EngineFS.on("stream-open", function(infoHash, fileIndex) { var e = getEngine(infoHash); e.ready(function() 
{
    var file = e.torrent.files[fileIndex];
    if (file.__cacheEvents) return;
    file.__cacheEvents = true;
    EngineFS.emit("stream-created", infoHash, fileIndex, file);

    var startPiece = (file.offset / e.torrent.pieceLength) | 0;
    var endPiece = ((file.offset+file.length-1) / e.torrent.pieceLength) | 0;
    var fpieces = [ ];
    for (var i=startPiece; i<=endPiece; i++) if (! e.bitfield.get(i)) fpieces.push(i);
    var filePieces = Math.ceil(file.length / e.torrent.pieceLength);
    
    var onDownload = function(p) { 
        // remove from array
        if (p !== undefined) {
            var idx = fpieces.indexOf(p);
            if (idx == -1) return;
            fpieces.splice(idx, 1);
        }

        EngineFS.emit("stream-progress:"+infoHash+":"+fileIndex, (filePieces-fpieces.length)/filePieces, fpath);

        if (fpieces.length) return;

        var fpath = e.store.getDest && e.store.getDest(fileIndex); // getDest not supported in all torrent-stream versions
        EngineFS.emit("stream-cached:"+infoHash+":"+fileIndex, fpath, file);
        EngineFS.emit("stream-cached", infoHash, fileIndex, fpath, file);

        e.removeListener("download", onDownload);
        e.removeListener("verify", onDownload);
    };
    //e.on("download", onDownload); // only consider verified pieces downloaded, 
    e.on("verify", onDownload);  // since last torrent-stream only verify guarantees that piece is written

    onDownload(); // initial call in case file is already done

    /* New torrent-stream writes pieces only when they're verified, which means virtuals are
     * not going to be written down, which means we have a change to play a file without having it
     * fully commited to disk; make sure we do that by downloading the entire file in verified pieces 
     * 
     * Plus, we always guarantee we have the whole file requested
     */
    var vLen = e.torrent.realPieceLength || e.torrent.verificationLen;
    var startPiece = (file.offset / vLen) | 0;
    var endPiece = ((file.offset+file.length-1) / vLen) | 0;
    var ratio = vLen / e.torrent.pieceLength;
    if (! e.buffer) e.select(startPiece*ratio, (endPiece+1)*ratio, false);
}) });


/*  
 * More events wiring: stream-inactive, engine-active, engine-idle, engine-inactive
 */
function Emit(args)
{
    // Allow us to listen to events for a specific stream as well as in general (e.g. stream-close(hash,idx) vs stream-close:hash:idx)
    EngineFS.emit.apply(EngineFS, args);
    EngineFS.emit(args.join(":"));
};

new Counter(EngineFS, "stream-open", "stream-close", function(hash, idx) { return hash+":"+idx }, function(hash, idx) { 
    Emit(["stream-active",hash,idx])
}, function(hash, idx) {  
    Emit(["stream-inactive",hash,idx])
}, EngineFS.STREAM_TIMEOUT);

new Counter(EngineFS, "stream-open", "stream-close", function(hash, idx) { return hash }, function(hash) {
    Emit(["engine-active",hash]);
}, function(hash) {  
    Emit(["engine-inactive",hash]);
}, EngineFS.ENGINE_TIMEOUT); // Keep engines active for STREAM_TIMEOUT * 60

new Counter(EngineFS, "stream-created", "stream-cached", function(hash, idx) { return hash }, function() { }, function(hash) {  
    Emit(["engine-idle",hash]);
}, EngineFS.STREAM_TIMEOUT);


EngineFS.http = createServer;

EngineFS.sendCORSHeaders = sendCORSHeaders;
EngineFS.sendDLNAHeaders = sendDLNAHeaders;

EngineFS.create = createEngine;
EngineFS.exists = existsEngine;
EngineFS.remove = removeEngine;
EngineFS.settings = settingsEngine;
EngineFS.stats = statsEngine;
EngineFS.list = listEngines;

EngineFS.prewarmStream = prewarmStream;

EngineFS.router = externalRouter;

EngineFS.loggingEnabled = false;

module.exports = EngineFS;

