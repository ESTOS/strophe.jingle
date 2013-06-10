strophe.jingle
==============

webrtc connection plugin for strophe.js. As the name suggests, this uses Jingle (XEP-0166), mapping webRTCs SDP to Jingle and vice versa.

Features:
- tested with chrome and firefox
- trickle and non-trickle modes for ICE (XEP-0176). Even supports early candidates from peer using PRANSWER.
- support for fetching time-limited STUN/TURN credentials through XEP-0215. Use https://code.google.com/p/rfc5766-turn-server/ if you're looking for a TURN server which implements this method.
