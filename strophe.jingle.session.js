/* jshint -W117 */
// Jingle stuff
var JingleSession;

(function($){
JingleSession = function(me, sid, connection) {
    this.me = me;
    this.sid = sid;
    this.connection = connection;
    this.initiator = null;
    this.responder = null;
    this.isInitiator = null;
    this.peerjid = null;
    this.state = null;
    this.peerconnection = null;
    this.remoteStream = null;
    this.localSDP = null;
    this.remoteSDP = null;
    this.localStreams = [];
    this.relayedStreams = [];
    this.remoteStreams = [];
    this.startTime = null;
    this.stopTime = null;
    this.media_constraints = null;
    this.pc_constraints = null;
    this.ice_config = {};
    this.drip_container = [];

    this.usetrickle = true;
    this.usepranswer = false; // early transport warmup -- mind you, this might fail. depends on webrtc issue 1718
    this.usedrip = false; // dripping is sending trickle candidates not one-by-one

    this.hadstuncandidate = false;
    this.hadturncandidate = false;
    this.lasticecandidate = false;

    this.statsinterval = null;

    this.reason = null;

    this.addssrc = [];
    this.removessrc = [];
    this.pendingop = null;

    this.wait = true;

    // XEP-0172 support, non-standard
    this.nickname = null;

    // non-standard "please start muted" support for colibri/meet
    this.startmuted = false;

    // Filter for testcases with ICE Candidates
    this.filter_candidates = null;
}

JingleSession.prototype.initiate = function (peerjid, isInitiator) {
    var self = this;
    if (this.state !== null) {
        console.error('attempt to initiate on session ' + this.sid +
                  'in state ' + this.state);
        return;
    }
    this.isInitiator = isInitiator;
    this.state = 'pending';
    this.initiator = isInitiator ? this.me : peerjid;
    this.responder = !isInitiator ? this.me : peerjid;
    this.peerjid = peerjid;
    //console.log('create PeerConnection ' + JSON.stringify(this.ice_config));
    try {
        this.peerconnection = new RTCPeerconnection(this.ice_config,
                                                     this.pc_constraints);
    } catch (e) {
        console.error('Failed to create PeerConnection, exception: ',
                      e.message);
        console.error(e);
        return;
    }
    this.hadstuncandidate = false;
    this.hadturncandidate = false;
    this.lasticecandidate = false;
    this.peerconnection.onicecandidate = function (event) {
        self.sendIceCandidate(event.candidate);
    };
    this.peerconnection.onaddstream = function (event) {
        self.remoteStream = event.stream;
        self.remoteStreams.push(event.stream);
        $(document).trigger('remotestreamadded.jingle', [event, self.sid]);
    };
    this.peerconnection.onremovestream = function (event) {
        self.remoteStream = null;
        // FIXME: remove from this.remoteStreams
        $(document).trigger('remotestreamremoved.jingle', [event, self.sid]);
    };
    this.peerconnection.onsignalingstatechange = function (event) {
        if (!(self && self.peerconnection)) return;
    };
    this.peerconnection.oniceconnectionstatechange = function (event) {
        if (!(self && self.peerconnection)) return;
        switch (self.peerconnection.iceConnectionState) {
        case 'connected':
            this.startTime = new Date();
            break;
        case 'disconnected':
            this.stopTime = new Date();
            break;
        }
        $(document).trigger('iceconnectionstatechange.jingle', [self.sid, self]);
    };
    // add any local and relayed stream
    this.localStreams.forEach(function(stream) {
        self.peerconnection.addStream(stream);
    });
    this.relayedStreams.forEach(function(stream) {
        self.peerconnection.addStream(stream);
    });
};

JingleSession.prototype.accept = function () {
    var self = this;
    this.state = 'active';

    var pranswer = this.peerconnection.localDescription;
    if (!pranswer || pranswer.type != 'pranswer') {
        return;
    }
    console.log('going from pranswer to answer');
    if (this.usetrickle) {
        // remove candidates already sent from session-accept
        var lines = SDPUtil.find_lines(pranswer.sdp, 'a=candidate:');
        for (var i = 0; i < lines.length; i++) {
            pranswer.sdp = pranswer.sdp.replace(lines[i] + '\r\n', '');
        }
    }
    while (SDPUtil.find_line(pranswer.sdp, 'a=inactive')) {
        // FIXME: change any inactive to sendrecv or whatever they were originally
        pranswer.sdp = pranswer.sdp.replace('a=inactive', 'a=sendrecv');
    }
    var prsdp = new SDP(pranswer.sdp);
    var accept = $iq({to: this.peerjid,
             type: 'set'})
        .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
           action: 'session-accept',
           initiator: this.initiator,
           responder: this.responder,
           sid: this.sid });
    prsdp.toJingle(accept, this.initiator == this.me ? 'initiator' : 'responder');
    this.connection.sendIQ(accept,
        function () {
            var ack = {};
            ack.source = 'answer';
            $(document).trigger('ack.jingle', [self.sid, ack]);
        },
        function (stanza) {
            var error = ($(stanza).find('error').length) ? {
                code: $(stanza).find('error').attr('code'),
                reason: $(stanza).find('error :first')[0].tagName,
            }:{};
            error.source = 'answer';
            $(document).trigger('error.jingle', [self.sid, error]);
        },
    10000);

    var sdp = this.peerconnection.localDescription.sdp;
    while (SDPUtil.find_line(sdp, 'a=inactive')) {
        // FIXME: change any inactive to sendrecv or whatever they were originally
        sdp = sdp.replace('a=inactive', 'a=sendrecv');
    }
    this.peerconnection.setLocalDescription(new RTCSessionDescription({type: 'answer', sdp: sdp}),
        function () {
            //console.log('setLocalDescription success');
            $(document).trigger('setLocalDescription.jingle', [self.sid]);
        },
        function (e) {
            console.error('setLocalDescription failed', e);
        }
    );
};

JingleSession.prototype.terminate = function (reason) {
    this.state = 'ended';
    this.reason = reason;
    this.peerconnection.close();
    if (this.statsinterval !== null) {
        window.clearInterval(this.statsinterval);
        this.statsinterval = null;
    }
};

JingleSession.prototype.active = function () {
    return this.state == 'active';
};

JingleSession.prototype.sendIceCandidate = function (candidate) {
    var self = this;
    if (candidate && !this.lasticecandidate) {
        var ice = SDPUtil.iceparams(this.localSDP.media[candidate.sdpMLineIndex], this.localSDP.session);
        var jcand = SDPUtil.candidateToJingle(candidate.candidate);
        if (!(ice && jcand)) {
            console.error('failed to get ice && jcand');
            return;
        }
        ice.xmlns = 'urn:xmpp:jingle:transports:ice-udp:1';

        if (jcand.type === 'srflx') {
            this.hadstuncandidate = true;
        } else if (jcand.type === 'relay') {
            this.hadturncandidate = true;
        }

        if(this.filter_candidates === null || jcand.type === this.filter_candidates) {
            if (this.usetrickle) {
                console.log('sendIceCandidate using trickle');
                if (this.usedrip) {
                    if (this.drip_container.length === 0) {
                        // start 20ms callout
                        window.setTimeout(function () {
                            console.log('sending drip container');
                            if (self.drip_container.length === 0) return;
                            self.sendIceCandidates(self.drip_container);
                            self.drip_container = [];
                        }, 20);

                    }
                    this.drip_container.push(event.candidate);
                    return;
                } else {
                    console.log('sending single candidate');
                    self.sendIceCandidates([event.candidate]);
                }
            }
        }
    } else {
        console.log('sendIceCandidate: last candidate...');
        if (!this.usetrickle) {
            console.log('should send full offer now...');
            var init = $iq({to: this.peerjid,
                       type: 'set'})
                .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
                   action: this.peerconnection.localDescription.type == 'offer' ? 'session-initiate' : 'session-accept',
                   initiator: this.initiator,
                   sid: this.sid});
            if (this.nickname != null) {
                init.c('nick', {xmlns:'http://jabber.org/protocol/nick'}).t(this.nickname).up();
            }
            if (this.startmuted) {
                init.c('muted', {xmlns:'http://jitsi.org/protocol/meet#startmuted'}).up();
            }
            this.localSDP = new SDP(this.peerconnection.localDescription.sdp);
            this.localSDP.toJingle(init, this.initiator == this.me ? 'initiator' : 'responder');
            console.log('try to send ack(offer)...');
            this.connection.sendIQ(init,
                function () {
                    console.log('Sent session initiate (ACK, offer)...');
                    var ack = {};
                    ack.source = 'offer';
                    $(document).trigger('ack.jingle', [self.sid, ack]);
                },
                function (stanza) {
                    self.state = 'error';
                    self.peerconnection.close();
                    var error = ($(stanza).find('error').length) ? {
                        code: $(stanza).find('error').attr('code'),
                        reason: $(stanza).find('error :first')[0].tagName,
                    }:{};
                    error.source = 'offer';
                    $(document).trigger('error.jingle', [self.sid, error]);
                },
            10000);
        }
        this.lasticecandidate = true;
        console.log('Have we encountered any srflx candidates? ' + this.hadstuncandidate);
        console.log('Have we encountered any relay candidates? ' + this.hadturncandidate);

        if (!(this.hadstuncandidate || this.hadturncandidate) && this.peerconnection.signalingState != 'closed') {
            console.log('no candidates found!');
            $(document).trigger('nostuncandidates.jingle', [this.sid]);
        }
    }
};

JingleSession.prototype.sendIceCandidates = function (candidates) {
    console.log('sendIceCandidates', candidates);
    var cand = $iq({to: this.peerjid, type: 'set'})
        .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
           action: 'transport-info',
           initiator: this.initiator,
           sid: this.sid});
    for (var mid = 0; mid < this.localSDP.media.length; mid++) {
        var cands = candidates.filter(function (el) { return el.sdpMLineIndex == mid; });
        if (cands.length > 0) {
            var ice = SDPUtil.iceparams(this.localSDP.media[mid], this.localSDP.session);
            ice.xmlns = 'urn:xmpp:jingle:transports:ice-udp:1';
            cand.c('content', {creator: this.initiator == this.me ? 'initiator' : 'responder',
                   name: cands[0].sdpMid
            }).c('transport', ice);
            for (var i = 0; i < cands.length; i++) {
                cand.c('candidate', SDPUtil.candidateToJingle(cands[i].candidate)).up();
            }
            // add fingerprint
            if (SDPUtil.find_line(this.localSDP.media[mid], 'a=fingerprint:', this.localSDP.session)) {
                var tmp = SDPUtil.parse_fingerprint(SDPUtil.find_line(this.localSDP.media[mid], 'a=fingerprint:', this.localSDP.session));
                tmp.required = true;
                cand.c('fingerprint').t(tmp.fingerprint);
                delete tmp.fingerprint;
                cand.attrs(tmp);
                cand.up();
            }
            cand.up(); // transport
            cand.up(); // content
        }
    }
    // might merge last-candidate notification into this, but it is called alot later. See webrtc issue #2340
    //console.log('was this the last candidate', this.lasticecandidate);
    console.log('try to send ack(transportinfo)...');
    this.connection.sendIQ(cand,
        function () {
            var ack = {};
            ack.source = 'transportinfo';
            console.log('Sent session initiate (ACK, transportinfo)...');
            $(document).trigger('ack.jingle', [this.sid, ack]);
        },
        function (stanza) {
            var error = ($(stanza).find('error').length) ? {
                code: $(stanza).find('error').attr('code'),
                reason: $(stanza).find('error :first')[0].tagName,
            }:{};
            error.source = 'transportinfo';
            $(document).trigger('error.jingle', [this.sid, error]);
        },
    10000);
};


JingleSession.prototype.sendOffer = function () {
    //console.log('sendOffer...');
    var self = this;
    this.peerconnection.createOffer(function (sdp) {
            self.createdOffer(sdp);
        },
        function (e) {
            console.error('createOffer failed', e);
        },
        this.media_constraints
    );
};

JingleSession.prototype.createdOffer = function (sdp) {
    //console.log('createdOffer', sdp);
    var self = this;
    this.localSDP = new SDP(sdp.sdp);
    //this.localSDP.mangle();
    if (this.usetrickle) {
        var init = $iq({to: this.peerjid,
                   type: 'set'})
            .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
               action: 'session-initiate',
               initiator: this.initiator,
               sid: this.sid});
        if (this.nickname != null) {
            init.c('nick', {xmlns:'http://jabber.org/protocol/nick'}).t(this.nickname).up();
        }
        if (this.startmuted) {
            init.c('muted', {xmlns:'http://jitsi.org/protocol/meet#startmuted'}).up();
        }
        this.localSDP.toJingle(init, this.initiator == this.me ? 'initiator' : 'responder');
        this.connection.sendIQ(init,
            function () {
                var ack = {};
                ack.source = 'offer';
                $(document).trigger('ack.jingle', [self.sid, ack]);
            },
            function (stanza) {
                self.state = 'error';
                self.peerconnection.close();
                var error = ($(stanza).find('error').length) ? {
                    code: $(stanza).find('error').attr('code'),
                    reason: $(stanza).find('error :first')[0].tagName,
                }:{};
                error.source = 'offer';
                $(document).trigger('error.jingle', [self.sid, error]);
            },
        10000);
    }
    sdp.sdp = this.localSDP.raw;
    this.peerconnection.setLocalDescription(sdp, 
        function () {
            $(document).trigger('setLocalDescription.jingle', [self.sid]);
            //console.log('setLocalDescription success');
        },
        function (e) {
            console.error('setLocalDescription failed', e);
        }
    );
    var cands = SDPUtil.find_lines(this.localSDP.raw, 'a=candidate:');
    for (var i = 0; i < cands.length; i++) {
        var cand = SDPUtil.parse_icecandidate(cands[i]);
        if (cand.type == 'srflx') {
            this.hadstuncandidate = true;
        } else if (cand.type == 'relay') {
            this.hadturncandidate = true;
        }
    }
};

JingleSession.prototype.setRemoteDescription = function (elem, desctype) {
    //console.log('setting remote description... ', desctype);
    this.remoteSDP = new SDP('');
    this.remoteSDP.fromJingle(elem);
    if (this.peerconnection.remoteDescription !== null) {
        console.log('setRemoteDescription when remote description is not null, should be pranswer', this.peerconnection.remoteDescription);
        if (this.peerconnection.remoteDescription.type == 'pranswer') {
            var pranswer = new SDP(this.peerconnection.remoteDescription.sdp);
            for (var i = 0; i < pranswer.media.length; i++) {
                // make sure we have ice ufrag and pwd
                if (!SDPUtil.find_line(this.remoteSDP.media[i], 'a=ice-ufrag:', this.remoteSDP.session)) {
                    if (SDPUtil.find_line(pranswer.media[i], 'a=ice-ufrag:', pranswer.session)) {
                        this.remoteSDP.media[i] += SDPUtil.find_line(pranswer.media[i], 'a=ice-ufrag:', pranswer.session) + '\r\n';
                    } else {
                        console.warn('no ice ufrag?');
                    }
                    if (SDPUtil.find_line(pranswer.media[i], 'a=ice-pwd:', pranswer.session)) {
                        this.remoteSDP.media[i] += SDPUtil.find_line(pranswer.media[i], 'a=ice-pwd:', pranswer.session) + '\r\n';
                    } else {
                        console.warn('no ice pwd?');
                    }
                }
                // copy over candidates
                var lines = SDPUtil.find_lines(pranswer.media[i], 'a=candidate:');
                for (var j = 0; j < lines.length; j++) {
                    this.remoteSDP.media[i] += lines[j] + '\r\n';
                }
            }
            this.remoteSDP.raw = this.remoteSDP.session + this.remoteSDP.media.join('');
        }
    }
    var remotedesc = new RTCSessionDescription({type: desctype, sdp: this.remoteSDP.raw});
    
    this.peerconnection.setRemoteDescription(remotedesc,
        function () {
            //console.log('setRemoteDescription success');
        },
        function (e) {
            console.error('setRemoteDescription error', e);
        }
    );
};

JingleSession.prototype.addIceCandidate = function (elem) {
    var self = this;
    if (this.peerconnection.signalingState == 'closed') {
        return;
    }
    if (!this.peerconnection.remoteDescription && this.peerconnection.signalingState == 'have-local-offer') {
        console.log('trickle ice candidate arriving before session accept...');
        // create a PRANSWER for setRemoteDescription
        if (!this.remoteSDP) {
            var cobbled = 'v=0\r\n' +
                'o=- ' + '1923518516' + ' 2 IN IP4 0.0.0.0\r\n' +// FIXME
                's=-\r\n' +
                't=0 0\r\n';
            // first, take some things from the local description
            for (var i = 0; i < this.localSDP.media.length; i++) {
                cobbled += SDPUtil.find_line(this.localSDP.media[i], 'm=') + '\r\n';
                cobbled += SDPUtil.find_lines(this.localSDP.media[i], 'a=rtpmap:').join('\r\n') + '\r\n';
                if (SDPUtil.find_line(this.localSDP.media[i], 'a=mid:')) {
                    cobbled += SDPUtil.find_line(this.localSDP.media[i], 'a=mid:') + '\r\n';
                }
                cobbled += 'a=inactive\r\n';
            }
            this.remoteSDP = new SDP(cobbled);
        }
        // then add things like ice and dtls from remote candidate
        elem.each(function () {
            for (var i = 0; i < self.remoteSDP.media.length; i++) {
                if (SDPUtil.find_line(self.remoteSDP.media[i], 'a=mid:' + $(this).attr('name')) ||
                        self.remoteSDP.media[i].indexOf('m=' + $(this).attr('name')) === 0) {
                    if (!SDPUtil.find_line(self.remoteSDP.media[i], 'a=ice-ufrag:')) {
                        var tmp = $(this).find('transport');
                        self.remoteSDP.media[i] += 'a=ice-ufrag:' + tmp.attr('ufrag') + '\r\n';
                        self.remoteSDP.media[i] += 'a=ice-pwd:' + tmp.attr('pwd') + '\r\n';
                        tmp = $(this).find('transport>fingerprint');
                        if (tmp.length) {
                            self.remoteSDP.media[i] += 'a=fingerprint:' + tmp.attr('hash') + ' ' + tmp.text() + '\r\n';
                        } else {
                            console.log('no dtls fingerprint (webrtc issue #1718?)');
                            self.remoteSDP.media[i] += 'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:BAADBAADBAADBAADBAADBAADBAADBAADBAADBAAD\r\n';
                        }
                        break;
                    }
                }
            }
        });
        this.remoteSDP.raw = this.remoteSDP.session + this.remoteSDP.media.join('');

        // we need a complete SDP with ice-ufrag/ice-pwd in all parts
        // this makes the assumption that the PRANSWER is constructed such that the ice-ufrag is in all mediaparts
        // but it could be in the session part as well. since the code above constructs this sdp this can't happen however
        var iscomplete = this.remoteSDP.media.filter(function (mediapart) {
            return SDPUtil.find_line(mediapart, 'a=ice-ufrag:');
        }).length == this.remoteSDP.media.length;

        if (iscomplete) {
            console.log('setting pranswer');
            try {
                this.peerconnection.setRemoteDescription(new RTCSessionDescription({type: 'pranswer', sdp: this.remoteSDP.raw }),
                    function() {
                    },
                    function(e) {
                        console.log('setRemoteDescription pranswer failed', e.toString());
                    });
            } catch (e) {
                console.error('setting pranswer failed', e);
            }
        } else {
            //console.log('not yet setting pranswer');
        }
    }
    // operate on each content element
    elem.each(function () {
        // would love to deactivate this, but firefox still requires it
        var idx = -1;
        var i;
        for (i = 0; i < self.remoteSDP.media.length; i++) {
            if (SDPUtil.find_line(self.remoteSDP.media[i], 'a=mid:' + $(this).attr('name')) ||
                self.remoteSDP.media[i].indexOf('m=' + $(this).attr('name')) === 0) {
                idx = i;
                break;
            }
        }
        if (idx == -1) { // fall back to localdescription
            for (i = 0; i < self.localSDP.media.length; i++) {
                if (SDPUtil.find_line(self.localSDP.media[i], 'a=mid:' + $(this).attr('name')) ||
                    self.localSDP.media[i].indexOf('m=' + $(this).attr('name')) === 0) {
                    idx = i;
                    break;
                }
            }
        }
        var name = $(this).attr('name');
        // TODO: check ice-pwd and ice-ufrag?
        $(this).find('transport>candidate').each(function () {
            var line, candidate;
            line = SDPUtil.candidateFromJingle(this);
            candidate = new RTCIceCandidate({sdpMLineIndex: idx,
                                            sdpMid: name,
                                            candidate: line});
            try {
                self.peerconnection.addIceCandidate(candidate);
            } catch (e) {
                console.error('addIceCandidate failed', e.toString(), line);
            }
        });
    });
};

JingleSession.prototype.sendAnswer = function (provisional) {
    //console.log('createAnswer', provisional);
    var self = this;
    this.peerconnection.createAnswer(
        function (sdp) {
            self.createdAnswer(sdp, provisional);
        },
        function (e) {
            console.error('createAnswer failed', e);
        },
        this.media_constraints
    );
};

JingleSession.prototype.createdAnswer = function (sdp, provisional) {
    //console.log('createAnswer callback');
    var self = this;
    this.localSDP = new SDP(sdp.sdp);
    //this.localSDP.mangle();
    this.usepranswer = provisional === true;

    if (this.startmuted) {
        console.log('we got a request to start muted...');
        this.connection.jingle.localStream.getAudioTracks().forEach(function (track) {
            track.enabled = false;
        });
        // doing this freezes local video, too (which probably means it should be replaced
        // by a symbol
        this.connection.jingle.localStream.getVideoTracks().forEach(function (track) {
            track.enabled = false;
        });

        // set video to recvonly
        this.localSDP.media[1] = this.localSDP.media[1].replace('a=sendrecv', 'a=recvonly');
        // and remove a=ssrc lines. Weird things happen otherwise
        SDPUtil.find_lines(this.localSDP.media[1], 'a=ssrc:').forEach(function (line) {
            self.localSDP.media[1] = self.localSDP.media[1].replace(line + '\r\n', '');
        });
        this.localSDP.raw = this.localSDP.session + this.localSDP.media.join('');
    }

    if (this.usetrickle) {
        if (!this.usepranswer) {
            var accept = $iq({to: this.peerjid,
                     type: 'set'})
                .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
                   action: 'session-accept',
                   initiator: this.initiator,
                   responder: this.responder,
                   sid: this.sid });
            this.localSDP.toJingle(accept, this.initiator == this.me ? 'initiator' : 'responder');
            this.connection.sendIQ(accept,
                function () {
                    var ack = {};
                    ack.source = 'answer';
                    $(document).trigger('ack.jingle', [self.sid, ack]);
                },
                function (stanza) {
                    var error = ($(stanza).find('error').length) ? {
                        code: $(stanza).find('error').attr('code'),
                        reason: $(stanza).find('error :first')[0].tagName,
                    }:{};
                    error.source = 'answer';
                    $(document).trigger('error.jingle', [self.sid, error]);
                },
            10000);
        } else {
            sdp.type = 'pranswer';
            for (var i = 0; i < this.localSDP.media.length; i++) {
                this.localSDP.media[i] = this.localSDP.media[i].replace('a=sendrecv\r\n', 'a=inactive\r\n');
            }
            this.localSDP.raw = this.localSDP.session + this.localSDP.media.join('');
        }
    }
    sdp.sdp = this.localSDP.raw;
    this.peerconnection.setLocalDescription(sdp,
        function () {
            $(document).trigger('setLocalDescription.jingle', [self.sid]);
            //console.log('setLocalDescription success');
        },
        function (e) {
            console.error('setLocalDescription failed', e);
        }
    );
    var cands = SDPUtil.find_lines(this.localSDP.raw, 'a=candidate:');
    for (var j = 0; j < cands.length; j++) {
        var cand = SDPUtil.parse_icecandidate(cands[j]);
        if (cand.type == 'srflx') {
            this.hadstuncandidate = true;
        } else if (cand.type == 'relay') {
            this.hadturncandidate = true;
        }
    }
};

JingleSession.prototype.sendTerminate = function (reason, text) {
    var self = this,
        term = $iq({to: this.peerjid,
               type: 'set'})
        .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
           action: 'session-terminate',
           initiator: this.initiator,
           sid: this.sid})
        .c('reason')
        .c(reason || 'success');
        
    if (text) {
        term.up().c('text').t(text);
    }
    
    this.connection.sendIQ(term,
        function () {
            self.peerconnection.close();
            self.peerconnection = null;
            self.terminate();
            var ack = {};
            ack.source = 'terminate';
            $(document).trigger('ack.jingle', [self.sid, ack]);
        },
        function (stanza) {
            var error = ($(stanza).find('error').length) ? {
                code: $(stanza).find('error').attr('code'),
                reason: $(stanza).find('error :first')[0].tagName,
            }:{};
            $(document).trigger('ack.jingle', [self.sid, error]);
        },
    10000);
    if (this.statsinterval !== null) {
        window.clearInterval(this.statsinterval);
        this.statsinterval = null;
    }
};


JingleSession.prototype.addSource = function (elem) {
    console.log('addssrc', new Date().getTime());
    console.log('ice', this.peerconnection.iceConnectionState);
    var sdp = new SDP(this.peerconnection.remoteDescription.sdp);

    var self = this;
    $(elem).each(function (idx, content) {
        var name = $(content).attr('name');
        var lines = '';
        tmp = $(content).find('>source[xmlns="urn:xmpp:jingle:apps:rtp:ssma:0"]');
        tmp.each(function () {
            var ssrc = $(this).attr('ssrc');
            $(this).find('>parameter').each(function () {
                lines += 'a=ssrc:' + ssrc + ' ' + $(this).attr('name');
                if ($(this).attr('value') && $(this).attr('value').length)
                    lines += ':' + $(this).attr('value');
                lines += '\r\n';
            });
        });
        sdp.media.forEach(function(media, idx) {
            if (!SDPUtil.find_line(media, 'a=mid:' + name))
                return;
            sdp.media[idx] += lines;
            if (!self.addssrc[idx]) self.addssrc[idx] = '';
            self.addssrc[idx] += lines;
        });
        sdp.raw = sdp.session + sdp.media.join('');
    });
    this.modifySources();
};

JingleSession.prototype.removeSource = function (elem) {
    console.log('removessrc', new Date().getTime());
    console.log('ice', this.peerconnection.iceConnectionState);
    var sdp = new SDP(this.peerconnection.remoteDescription.sdp);

    var self = this;
    $(elem).each(function (idx, content) {
        var name = $(content).attr('name');
        var lines = '';
        tmp = $(content).find('>source[xmlns="urn:xmpp:jingle:apps:rtp:ssma:0"]');
        tmp.each(function () {
            var ssrc = $(this).attr('ssrc');
            $(this).find('>parameter').each(function () {
                lines += 'a=ssrc:' + ssrc + ' ' + $(this).attr('name');
                if ($(this).attr('value') && $(this).attr('value').length)
                    lines += ':' + $(this).attr('value');
                lines += '\r\n';
            });
        });
        sdp.media.forEach(function(media, idx) {
            if (!SDPUtil.find_line(media, 'a=mid:' + name))
                return;
            sdp.media[idx] += lines;
            if (!self.addssrc[idx]) self.removessrc[idx] = '';
            self.removessrc[idx] += lines;
        });
        sdp.raw = sdp.session + sdp.media.join('');
    });
    this.modifySources();
};

JingleSession.prototype.modifySources = function() {
    var self = this;
    if (this.peerconnection.signalingState == 'closed') return;
    if (!(this.addssrc.length || this.removessrc.length || this.pendingop !== null)) return;
    if (!(this.peerconnection.signalingState == 'stable' && this.peerconnection.iceConnectionState == 'connected')) {
        console.warn('modifySources not yet', this.peerconnection.signalingState, this.peerconnection.iceConnectionState);
        this.wait = true;
        window.setTimeout(function() { self.modifySources(); }, 250);
        return;
    }
    if (this.wait) {
        window.setTimeout(function() { self.modifySources(); }, 2500);
        this.wait = false;
        return;
    }

    var sdp = new SDP(this.peerconnection.remoteDescription.sdp);

    // add sources
    this.addssrc.forEach(function(lines, idx) {
        sdp.media[idx] += lines;
    });
    this.addssrc = [];

    // remove sources
    this.removessrc.forEach(function(lines, idx) {
        lines = lines.split('\r\n');
        lines.pop(); // remove empty last element;
        lines.forEach(function(line) {
            sdp.media[idx] = sdp.media[idx].replace(line + '\r\n', '');
        });
    });
    this.removessrc = [];

    sdp.raw = sdp.session + sdp.media.join('');
    this.peerconnection.setRemoteDescription(new RTCSessionDescription({type: 'offer', sdp: sdp.raw}),
        function() {
            self.peerconnection.createAnswer(
                function(modifiedAnswer) {
                    // change video direction, see https://github.com/jitsi/jitmeet/issues/41
                    if (self.pendingop !== null) {
                        var sdp = new SDP(modifiedAnswer.sdp);
                        if (sdp.media.length > 1) {
                            switch(self.pendingop) {
                            case 'mute':
                                sdp.media[1] = sdp.media[1].replace('a=sendrecv', 'a=recvonly');
                                break;
                            case 'unmute':
                                sdp.media[1] = sdp.media[1].replace('a=recvonly', 'a=sendrecv');
                                break;
                            }
                            sdp.raw = sdp.session + sdp.media.join('');
                            modifiedAnswer.sdp = sdp.raw;
                        }
                        self.pendingop = null;
                    }

                    self.peerconnection.setLocalDescription(modifiedAnswer,
                        function() {
                            //console.log('modified setLocalDescription ok');
                            $(document).trigger('setLocalDescription.jingle', [self.sid]);
                        },
                        function(error) {
                            console.log('modified setLocalDescription failed');
                        }
                    );
                },
                function(error) {
                    console.log('modified answer failed');
                }
            );
        },
        function(error) {
            console.log('modify failed');
        }
    );
};

// SDP-based mute by going recvonly/sendrecv
// FIXME: should probably black out the screen as well
JingleSession.prototype.hardMuteVideo = function (muted) {
    this.pendingop = muted ? 'mute' : 'unmute';
    this.modifySources();

    this.connection.jingle.localStream.getVideoTracks().forEach(function (track) {
        track.enabled = !muted;
    });
};

JingleSession.prototype.sendMute = function (muted, content) {
    var info = $iq({to: this.peerjid,
             type: 'set'})
        .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
           action: 'session-info',
           initiator: this.initiator,
           sid: this.sid });
    info.c(muted ? 'mute' : 'unmute', {xmlns: 'urn:xmpp:jingle:apps:rtp:info:1'});
    info.attrs({'creator': this.me == this.initiator ? 'creator' : 'responder'});
    if (content) {
        info.attrs({'name': content});
    }
    this.connection.send(info);
};

JingleSession.prototype.sendRinging = function () {
    var info = $iq({to: this.peerjid,
             type: 'set'})
        .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
           action: 'session-info',
           initiator: this.initiator,
           sid: this.sid });
    info.c('ringing', {xmlns: 'urn:xmpp:jingle:apps:rtp:info:1'});
    this.connection.send(info);
};

JingleSession.prototype.getStats = function (interval) {
    var self = this;
    var recv = {audio: 0, video: 0};
    var lost = {audio: 0, video: 0};
    var lastrecv = {audio: 0, video: 0};
    var lastlost = {audio: 0, video: 0};
    var loss = {audio: 0, video: 0};
    var delta = {audio: 0, video: 0};
    this.statsinterval = window.setInterval(function () {
        if (self && self.peerconnection && self.peerconnection.getStats) {
            self.peerconnection.getStats(function (stats) {
                var results = stats.result();
                // TODO: there are so much statistics you can get from this..
                for (var i = 0; i < results.length; ++i) {
                    if (results[i].type == 'ssrc') {
                        var packetsrecv = results[i].stat('packetsReceived');
                        var packetslost = results[i].stat('packetsLost');
                        if (packetsrecv && packetslost) {
                            packetsrecv = parseInt(packetsrecv, 10);
                            packetslost = parseInt(packetslost, 10);
                            
                            if (results[i].stat('googFrameRateReceived')) {
                                lastlost.video = lost.video;
                                lastrecv.video = recv.video;
                                recv.video = packetsrecv;
                                lost.video = packetslost;
                            } else {
                                lastlost.audio = lost.audio;
                                lastrecv.audio = recv.audio;
                                recv.audio = packetsrecv;
                                lost.audio = packetslost;
                            }
                        }
                    }
                }
                delta.audio = recv.audio - lastrecv.audio;
                delta.video = recv.video - lastrecv.video;
                loss.audio = (delta.audio > 0) ? Math.ceil(100 * (lost.audio - lastlost.audio) / delta.audio) : 0;
                loss.video = (delta.video > 0) ? Math.ceil(100 * (lost.video - lastlost.video) / delta.video) : 0;
                $(document).trigger('packetloss.jingle', [self.sid, loss]);
            });
        }
    }, interval || 3000);
    return this.statsinterval;
};

}(jQuery));
