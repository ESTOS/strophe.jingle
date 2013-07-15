// Jingle stuff
function JingleSession(me, sid, connection) {
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
    this.localStream = null;
    this.startTime = null;
    this.stopTime = null;
    this.media_constraints = null;
    this.pc_constraints = null;
    this.ice_config = {};

    this.noearlycandidates = false; // TODO: remove once WRTC-30 bug is closed
    this.usetrickle = true; // TODO: usetrickle = false and noearlycandidates is unlikely to work
    this.usepranswer = false; // early transport warmup -- mind you, this might fail. depends on webrtc issue 1718

    this.hadstuncandidate = false;
    this.hadturncandidate = false;
    this.lasticecandidate = false;

    this.reason = null;
}

JingleSession.prototype.initiate = function(peerjid, isInitiator) {
    var obj = this;
    if (this.state != null) {
        console.error('attempt to initiate on session ' + this.sid +
                  'in state ' + this.state);
        return;
    }
    this.isInitiator = isInitiator;
    this.state = 'pending';
    this.initiator = isInitiator ? this.me : peerjid;
    this.responder = !isInitiator ? this.me : peerjid;
    this.peerjid = peerjid;
    console.log('create PeerConnection ' + JSON.stringify(this.ice_config));
    try {
        this.peerconnection = new RTCPeerconnection(this.ice_config,
                                                     this.pc_constraints);
        console.log('Created RTCPeerConnnection');
    } catch (e) {
        console.error('Failed to create PeerConnection, exception: ',
                      e.message);
        console.error(e);
        return;
    }
    this.hadstuncandidate = false;
    this.hadturncandidate = false;
    this.lasticecandidate = false;
    this.peerconnection.onicecandidate = function(event) {
        obj.sendIceCandidate(event.candidate);
    };
    this.peerconnection.onaddstream = function(event) {
        obj.remoteStream = event.stream;
        $(document).trigger('remotestreamadded.jingle', [event, obj.sid]);
    };
    this.peerconnection.onremovestream = function(event) {
        obj.remoteStream = null;
        $(document).trigger('remotestreamremoved.jingle', [event, obj.sid]);
    };
    this.peerconnection.onsignalingstatechange = function(event) {
        if (!(obj && obj.peerconnection)) return;
        console.log('signallingstate ', obj.peerconnection.signalingState, event);
    };
    this.peerconnection.oniceconnectionstatechange = function(event) {
        if (!(obj && obj.peerconnection)) return;
        console.log('iceconnectionstatechange', obj.peerconnection.iceConnectionState, event);
        switch (obj.peerconnection.iceConnectionState) {
        case 'connected':
            this.startTime = new Date();
            break;
        case 'disconnected':
            this.stopTime = new Date();
            break;
        }
        $(document).trigger('iceconnectionstatechange.jingle', [obj.sid, obj]);
    };
    if (this.localStream != null) {
        this.peerconnection.addStream(this.localStream);
    } else {
        console.warn('attempting to initate a jingle session without a local stream');
    }
};

JingleSession.prototype.accept = function() {
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
                   function() { console.log('session accept ack'); },
                   function() { console.error('session accept error'); },
                   10000);

    var sdp = this.peerconnection.localDescription.sdp;
    while (SDPUtil.find_line(sdp, 'a=inactive')) {
        // FIXME: change any inactive to sendrecv or whatever they were originally
        sdp = sdp.replace('a=inactive', 'a=sendrecv');
    }
    try {
        this.peerconnection.setLocalDescription(new RTCSessionDescription({type: 'answer', sdp: sdp}));
    } catch (e) {
        console.error('setLocalDescription failed');
        console.error(e.toString());
    }
};

JingleSession.prototype.terminate = function(reason) {
    this.state = 'ended';
    this.reason = reason;
    this.peerconnection.close();
};

JingleSession.prototype.active = function() {
    return this.state == 'active';
};

JingleSession.prototype.sendIceCandidate = function(candidate) {
    var ob = this; 
    if (candidate && !this.lasticecandidate) {
        var ice = SDPUtil.iceparams(this.localSDP.media[candidate.sdpMLineIndex], this.localSDP.session),
            jcand = SDPUtil.candidateToJingle(candidate.candidate);
        if (!(ice && jcand)) {
            console.error('failed to get ice && jcand');
            return;
        }

        if (jcand.type === 'srflx') {
            this.hadstuncandidate = true;
        } else if (jcand.type === 'relay') {
            this.hadturncandidate = true;
        }
        console.log(event.candidate, jcand);

        if (this.usetrickle) {
            // map to transport-info
            var cand = $iq({to: this.peerjid, type: 'set'})
                .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
                        action: 'transport-info',
                        initiator: this.initiator,
                        sid: this.sid})
                .c('content', {creator: this.initiator == this.me ? 'initiator' : 'responder',
                        name: candidate.sdpMid
                        })
                .c('transport', ice)
                .c('candidate', jcand);
            cand.up();
            // add fingerprint
            if (SDPUtil.find_line(this.localSDP.media[candidate.sdpMLineIndex], 'a=fingerprint:', this.localSDP.session)) {
                tmp = SDPUtil.parse_fingerprint(SDPUtil.find_line(this.localSDP.media[candidate.sdpMLineIndex], 'a=fingerprint:', this.localSDP.session));
                tmp.required = true;
                cand.c('fingerprint').t(tmp.fingerprint);
                delete tmp.fingerprint;
                cand.attrs(tmp);
                cand.up();
            }
            this.connection.sendIQ(cand,
                           function() { 
                               console.log('transport info ack'); 
                           },
                           function(stanza) { 
                                console.error('transport info error'); 
                                var error = ($(stanza).find('error').length) ? {
                                    code: $(stanza).find('error').attr('code'),
                                    reason: $(stanza).find('error :first')[0].tagName,
                                }:{};
                                error.source = 'offer';
                                $(document).trigger('error.jingle', [ob.sid, error]);
                            },
                           10000);
        }
    } else {
        console.log('sendIceCandidate: last candidate.');
        if (!this.usetrickle) {
            console.log('should send full offer now...');
            var init = $iq({to: this.peerjid,
                       type: 'set'})
                .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
                   action: 'session-initiate',
                   initiator: this.initiator,
                   sid: this.sid});
            this.localSDP = new SDP(this.peerconnection.localDescription.sdp);
            this.localSDP.toJingle(init, this.initiator == this.me ? 'initiator' : 'responder');
            this.connection.sendIQ(init,
                function() {
                    console.log('session initiate ack');
                },
                function(stanza) {
                    ob.state = 'error';
                    ob.peerconnection.close();
                    console.error('session initiate error');
                    var error = ($(stanza).find('error').length) ? {
                        code: $(stanza).find('error').attr('code'),
                        reason: $(stanza).find('error :first')[0].tagName,
                    }:{};
                    error.source = 'offer';
                    $(document).trigger('error.jingle', [ob.sid, error]);
                },
            10000);
        }
        this.lasticecandidate = true;
        console.log('Have we encountered any srflx candidates? ' + this.hadstuncandidate);
        console.log('Have we encountered any relay candidates? ' + this.hadturncandidate);

        if (!(this.hadstuncandidate || this.hadturncandidate) && this.peerconnection.signalingState != 'closed') {
            $(document).trigger('nostuncandidates.jingle', [this.sid]);
        }
    }
};

JingleSession.prototype.sendOffer = function() {
    console.log('sendOffer...');
    var ob = this;
    this.peerconnection.createOffer(function(sdp) {
            ob.createdOffer(sdp);
        },
        function(e) {
            console.error('createOffer failed', e);
        },
        this.media_constraints
    );
};

JingleSession.prototype.createdOffer = function(sdp) {
    console.log('createdOffer', sdp);
    var ob = this;
    this.localSDP = new SDP(sdp.sdp);
    this.localSDP.mangle();
    if (this.usetrickle) {
        var init = $iq({to: this.peerjid,
                   type: 'set'})
            .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
               action: 'session-initiate',
               initiator: this.initiator,
               sid: this.sid});
        this.localSDP.toJingle(init, this.initiator == this.me ? 'initiator' : 'responder');
        this.connection.sendIQ(init,
            function() {
                console.log('offer initiate ack');
            },
            function(stanza) {
                ob.state = 'error';
                ob.peerconnection.close();
                console.error('offer initiate error');
                var error = ($(stanza).find('error').length) ? {
                    code: $(stanza).find('error').attr('code'),
                    reason: $(stanza).find('error :first')[0].tagName,
                }:{};
                error.source = 'offer';
                $(document).trigger('error.jingle', [ob.sid, error]);
            },
        10000);
    }
    sdp.sdp = this.localSDP.raw;
    if (this.noearlycandidates) {
        console.log('delaying setLocalDescription...');
        return;
    }
    try {
        this.peerconnection.setLocalDescription(sdp);
    } catch (e) {
        console.error('setLocalDescription failed');
        console.error(e.toString());
    }
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

JingleSession.prototype.setRemoteDescription = function(elem, desctype) {
    console.log('setting remote description... ', desctype);
    this.remoteSDP = new SDP('');
    this.remoteSDP.fromJingle(elem);
    //this.remoteSDP = new SDP(elem.text());

    /*
    // hack to remove a=fingerprint while DTLS support on android is broken
    if (navigator.userAgent.indexOf('Android') != -1) {
        while (SDPUtil.find_line(this.remoteSDP.raw, 'a=fingerprint:')) {
            this.remoteSDP.raw = this.remoteSDP.raw.replace(SDPUtil.find_line(this.remoteSDP.raw, 'a=fingerprint:') + '\r\n', '');
        }
    }
    */
    if (this.noearlycandidates && desctype == 'answer') {
        console.warn('delayed setLocalDescription is here...');
        this.peerconnection.setLocalDescription(new RTCSessionDescription({type: 'offer', sdp: this.localSDP.raw}));
    }
    if (this.peerconnection.remoteDescription != null) {
        console.log('setRemoteDescription when remote description is not null, should be pranswer', this.peerconnection.remoteDescription);
        if (this.peerconnection.remoteDescription.type == 'pranswer') {
            var pranswer = new SDP(this.peerconnection.remoteDescription.sdp);
            for (var i = 0; i < pranswer.media.length; i++) {
                var lines = SDPUtil.find_lines(pranswer.media[i], 'a=candidate:');
                for (var j = 0; j < lines.length; j++) {
                    this.remoteSDP.media[i] += lines[j] + '\r\n';
                }
            }
            this.remoteSDP.raw = this.remoteSDP.session + this.remoteSDP.media.join('');
        }
    }
    var remotedesc = new RTCSessionDescription({type: desctype, sdp: this.remoteSDP.raw});
    
    this.peerconnection.setRemoteDescription(remotedesc, function(e){
        console.log('setRemoteDescription success');
    }, function(e){
        console.error('setRemoteDescription error', e);
    });
};

JingleSession.prototype.addIceCandidate = function(elem) {
    var obj = this;
    if (this.peerconnection.readyState == 'closed') {
        return;
    }
    if (!this.peerconnection.remoteDescription) {
        console.log('trickle ice candidate arriving before session accept...');
        // create a PRANSWER for setRemoteDescription
        if (!this.remoteSDP) {
            var cobbled = 'v=0\r\n' +
                'o=- ' + '1923518516' + ' 2 IN IP4 0.0.0.0\r\n' +// FIXME
                's=-\r\n' +
                't=0 0\r\n';
            // first, take some things from the local description
            for (i = 0; i < this.localSDP.media.length; i++) {
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
        elem.each(function() {
            for (var i = 0; i < obj.remoteSDP.media.length; i++) {
                if (SDPUtil.find_line(obj.remoteSDP.media[i], 'a=mid:' + $(this).attr('name')) ||
                        obj.remoteSDP.media[i].indexOf('m=' + $(this).attr('name')) == 0) {
                    if (!SDPUtil.find_line(obj.remoteSDP.media[i], 'a=ice-ufrag:')) {
                        obj.remoteSDP.media[i] += '\r\n';
                        var tmp = $(this).find('transport');
                        obj.remoteSDP.media[i] += 'a=ice-ufrag:' + tmp.attr('ufrag') + '\r\n';
                        obj.remoteSDP.media[i] += 'a=ice-pwd:' + tmp.attr('pwd') + '\r\n';
                        tmp = $(this).find('transport>fingerprint');
                        if (tmp.length) {
                            obj.remoteSDP.media[i] += 'a=fingerprint:' + tmp.attr('hash') + ' ' + tmp.text() + '\r\n';
                        } else {
                            console.log('no dtls fingerprint (webrtc issue #1718?)');
                            obj.remoteSDP.media[i] += 'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:BAADBAADBAADBAADBAADBAADBAADBAADBAADBAAD\r\n';
                        }
                        break;
                    }
                }
            }
        });
        this.remoteSDP.raw = this.remoteSDP.session + '\r\n' + this.remoteSDP.media.join(''); // + '\r\n';

        // we need a complete SDP with ice-ufrag/ice-pwd in all parts
        // this makes the assumption that the PRANSWER is constructed such that the ice-ufrag is in all mediaparts
        // but it could be in the session part as well. since the code above constructs this sdp this can't happen however
        var iscomplete = this.remoteSDP.media.filter(function(mediapart) {
            return SDPUtil.find_line(mediapart, 'a=ice-ufrag:');
        }).length == this.remoteSDP.media.length;

        if (iscomplete) {
            console.log('setting pranswer');
            try {
                this.peerconnection.setRemoteDescription(new RTCSessionDescription({type: 'pranswer', sdp: this.remoteSDP.raw }));
            } catch (e) {
                console.error('setting pranswer failed', e);
            }
        } else {
            console.log('not yet setting pranswer');
        }
    }
    // operate on each content element
    elem.each(function() {
        // would love to deactivate this, but firefox still requires it
        var idx = -1;
        var i;
        for (i = 0; i < obj.remoteSDP.media.length; i++) {
            if (SDPUtil.find_line(obj.remoteSDP.media[i], 'a=mid:' + $(this).attr('name')) ||
                obj.remoteSDP.media[i].indexOf('m=' + $(this).attr('name')) == 0) {
                idx = i;
                break;
            }
        }
        if (idx == -1) { // fall back to localdescription
            for (i = 0; i < obj.localSDP.media.length; i++) {
                if (SDPUtil.find_line(obj.localSDP.media[i], 'a=mid:' + $(this).attr('name')) ||
                    obj.localSDP.media[i].indexOf('m=' + $(this).attr('name')) == 0) {
                    idx = i;
                    break;
                }
            }
        }
        var name = $(this).attr('name');
        // TODO: check ice-pwd and ice-ufrag?
        $(this).find('transport>candidate').each(function() {
            var line, candidate;
            line = SDPUtil.candidateFromJingle(this);
            candidate = new RTCIceCandidate({sdpMLineIndex: idx,
                                            sdpMid: name,
                                            candidate: line});
            console.log(candidate);
            try {
            obj.peerconnection.addIceCandidate(candidate);
            } catch (e) {
            console.error('addIceCandidate failed', e.toString(), line);
            }
            });
    });
};

JingleSession.prototype.sendAnswer = function(provisional) {
    console.log('createAnswer', provisional);
    var ob = this;
    this.peerconnection.createAnswer(
        function(sdp) {
            ob.createdAnswer(sdp, provisional);
        },
        function(e) {
            console.error('createAnswer failed', e);
        },
        this.media_constraints
    );
};

JingleSession.prototype.createdAnswer = function(sdp, provisional) {
    console.log('createAnswer callback');
    console.log(sdp);
    this.localSDP = new SDP(sdp.sdp);
    this.localSDP.mangle();
    this.usepranswer = provisional == true;
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
                           function() { console.log('session accept ack'); },
                           function() { console.error('session accept error'); },
                           10000);
        } else {
            sdp.type = 'pranswer';
            for (i = 0; i < this.localSDP.media.length; i++) {
                this.localSDP.media[i] = this.localSDP.media[i].replace('a=sendrecv\r\n', 'a=inactive\r\n');
            }
            this.localSDP.raw = this.localSDP.session + '\r\n' + this.localSDP.media.join('') + '\r\n';
        }
    }
    sdp.sdp = this.localSDP.raw;
    try {
        this.peerconnection.setLocalDescription(sdp);
    } catch (e) {
        console.error('setLocalDescription failed');
        console.error(e.toString());
    }
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

JingleSession.prototype.sendTerminate = function(reason, text) {
    var obj = this,
        term = $iq({to: this.peerjid,
               type: 'set'})
        .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
           action: 'session-terminate',
           initiator: this.initiator,
           sid: this.sid})
        .c('reason')
        .c(reason || 'success');
        
    if(text)
        term.up().c('text').t(text);
    
    this.connection.sendIQ(term,
                   function() {
                   console.log('terminate ack');
                   obj.peerconnection.close();
                   obj.peerconnection = null;
                   obj.terminate();
                   },
                   function() { console.log('terminate error'); },
                   10000);
};

JingleSession.prototype.sendMute = function(muted, content) {
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

JingleSession.prototype.sendRinging = function() {
    var info = $iq({to: this.peerjid,
             type: 'set'})
        .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
           action: 'session-info',
           initiator: this.initiator,
           sid: this.sid });
    info.c('ringing', {xmlns: 'urn:xmpp:jingle:apps:rtp:info:1'});
    this.connection.send(info);
};
