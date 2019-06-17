module.exports = function(RED) {
    "use strict";
    var fs = require("fs-extra");
    var os = require("os");
    var path = require("path");
    var iconv = require("iconv-lite")
    var moment = require('moment')
    var mkdirp = require('mkdirp');

    function encode(data, enc) {
        if (enc !== "none") {
            return iconv.encode(data, enc);
        }
        return Buffer.from(data);
    }
  
    function FileNode(n) {
        RED.nodes.createNode(this,n);
        this.dirname = n.dirname;
        this.appendNewline = n.appendNewline;
        this.overwriteFile = n.overwriteFile.toString();
        this.createDir = n.createDir || false;
        this.encoding = n.encoding || "none";
        this.clear = n.clear;
        var node = this;
        node.wstream = null;
        node.msgQueue = [];
        node.closing = false;
        node.closeCallback = null;

        function processMsg(msg, done) {
            var date = moment().utc().utcOffset(8)
            var filename = `${date.format("YYYY-MM-DD-HH-mm-ss")}-${(Math.random() * 100).toFixed()}.${n.fileType}`
            var monthDir = date.format("YYYY-MM-DD")
            
            if ((!node.filename) && (!node.tout) && (!node.dirname)) {
                node.tout = setTimeout(function() {
                    node.status({fill:"grey",shape:"dot",text:filename});
                    clearTimeout(node.tout);
                    node.tout = null;
                },333);
            }
            var dirname = msg.dirname || node.dirname || "";

            if (dirname === "") {
                node.warn(RED._("file.errors.nofilename"));
                done();
            } else if (msg.hasOwnProperty("payload") && (typeof msg.payload !== "undefined")) {
                var dir = path.join(dirname, monthDir);
                
                if (node.createDir) {
                    try {
                        mkdirp.sync(dir)
                    } catch(err) {
                        node.error(RED._("file.errors.createfail",{error:err.toString()}),msg);
                        done();
                        return;
                    }
                }
                //相对路径
                msg.shortname = path.join(monthDir, filename)
                // 绝对路径的文件
                filename = path.join(dir, filename)
                msg.fullname = filename
                
                var data = msg.payload;
                //清空payload信息
                if (n.clear) {
                    msg.payload = {}
                }

                if ((typeof data === "object") && (!Buffer.isBuffer(data))) {
                    data = JSON.stringify(data);
                }
                if (typeof data === "boolean") { data = data.toString(); }
                if (typeof data === "number") { data = data.toString(); }
                if ((node.appendNewline) && (!Buffer.isBuffer(data))) { data += os.EOL; }
                var buf = encode(data, node.encoding);
                if (node.overwriteFile === "true") {
                    var wstream = fs.createWriteStream(filename, { encoding:'binary', flags:'w', autoClose:true });
                    node.wstream = wstream;
                    wstream.on("error", function(err) {
                        node.error(RED._("file.errors.writefail",{error:err.toString()}),msg);
                        done();
                    });
                    wstream.on("open", function() {
                        wstream.end(buf, function() {
                            node.send(msg);
                            done();
                        });
                    })
                    return;
                }
                else {
                    // Append mode
                    var recreateStream = !node.wstream || !node.dirname;
                    if (node.wstream && node.wstreamIno) {
                        // There is already a stream open and we have the inode
                        // of the file. Check the file hasn't been deleted
                        // or deleted and recreated.
                        try {
                            var stat = fs.statSync(filename);
                            // File exists - check the inode matches
                            if (stat.ino !== node.wstreamIno) {
                                // The file has been recreated. Close the current
                                // stream and recreate it
                                recreateStream = true;
                                node.wstream.end();
                                delete node.wstream;
                                delete node.wstreamIno;
                            }
                        } catch(err) {
                            // File does not exist
                            recreateStream = true;
                            node.wstream.end();
                            delete node.wstream;
                            delete node.wstreamIno;
                        }
                    }
                    if (recreateStream) {
                        node.wstream = fs.createWriteStream(filename, { encoding:'binary', flags:'a', autoClose:true });
                        node.wstream.on("open", function(fd) {
                            try {
                                var stat = fs.statSync(filename);
                                node.wstreamIno = stat.ino;
                            } catch(err) {
                            }
                        });
                        node.wstream.on("error", function(err) {
                            node.error(RED._("file.errors.appendfail",{error:err.toString()}),msg);
                            done();
                        });
                    }
                    if (node.dirname) {
                        // Static dirname - write and reuse the stream next time
                        node.wstream.write(buf, function() {
                            node.send(msg);
                            done();
                        });
                    } else {
                        // Dynamic dirname - write and close the stream
                        node.wstream.end(buf, function() {
                            node.send(msg);
                            delete node.wstream;
                            delete node.wstreamIno;
                            done();
                        });
                    }
                }
            }
            else {
                done();
            }
        }

        function processQ(queue) {
            var msg = queue[0];
            processMsg(msg, function() {
                queue.shift();
                if (queue.length > 0) {
                    processQ(queue);
                }
                else if (node.closing) {
                    closeNode();
                }
            });
        }

        this.on("input", function(msg) {
            var msgQueue = node.msgQueue;
            if (msgQueue.push(msg) > 1) {
                // pending write exists
                return;
            }
            try {
                processQ(msgQueue);
            }
            catch (e) {
                node.msgQueue = [];
                if (node.closing) {
                    closeNode();
                }
                throw e;
            }
        });

        function closeNode() {
            if (node.wstream) { node.wstream.end(); }
            if (node.tout) { clearTimeout(node.tout); }
            node.status({});
            var cb = node.closeCallback;
            node.closeCallback = null;
            node.closing = false;
            if (cb) {
                cb();
            }
        }

        this.on('close', function(done) {
            if (node.closing) {
                // already closing
                return;
            }
            node.closing = true;
            if (done) {
                node.closeCallback = done;
            }
            if (node.msgQueue.length > 0) {
                // close after queue processed
                return;
            }
            else {
                closeNode();
            }
        });
    }
    RED.nodes.registerType("time-photo-files",FileNode);
}