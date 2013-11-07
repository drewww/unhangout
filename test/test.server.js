var server = require('../lib/unhangout-server'),
	should = require('should'),
	_ = require('underscore')._,
	sock_client = require('sockjs-client'),
	request = require('superagent'),
	seed = require('../bin/seed.js'),
    common = require("./common");

var s;
var sock;
var session;

var joinEventSetup = function(done) {
	connectNewSock(function(newSock) {
		sock = newSock;
		done();
	});
};

// TODO This doesn't really work unless we have more mock users on the server for testing,
// and I don't have a clean way of doing that just yet. Annoying. For now, stick with single
// user tests.
function connectNewSock(callback) {
	var newSock = sock_client.create("http://localhost:7777/sock");
	newSock.on("data", function(message) {
		var msg = JSON.parse(message);

		if(msg.type=="auth-ack") {
			// Joining event id 1 for all these tests, valid session ids for that
			// event are 1, 2, 3 (invalid are 4, 5, 6)
			newSock.write(JSON.stringify({type:"join", args:{id:1}}));
		} else if(msg.type=="join-ack") {
			newSock.removeAllListeners();
			callback && callback(newSock);
		}
	});

	newSock.on("connection", function() {
		var user = common.server.users.at(common.server.users.length-1);
		newSock.write(JSON.stringify({type:"auth", args:{key:user.getSockKey(), id:user.id}}));
	});
}

describe('unhangout server', function() {
	describe('configuration', function() {
		beforeEach(function() {
			s = new server.UnhangoutServer();
		});
		
		it('should not initialize without google credentials', function(done) {
			s.on("error", function() {
				done();
			});
			s.on("inited", function() {
				should.fail("Expected an error.");
			});
			s.init({"transport":"file", "level":"debug"});
		});
		
		it('#start should fail if init is not called first', function(done) {
			s.on("error", function() {
				done();
			});
			
			s.on("started", function() {
				should.fail("expected an error");
			});
			s.start();
		});
		
		it("#stop should fail if not started", function(done) {
			s.on("error", function() {
				done();
			});
			
			s.on("started", function() {
				should.fail("expected an error");
			});
			s.stop();
		});
		
		it("#destroy should succeed regardless of state", function(done) {
			s.on("destroyed", function() {
				done();
			});
			
			s.on("error", function() {
				should.fail();
			})
			
			s.destroy();
		});
	});
	
	
	describe('setup', function() {
		beforeEach(function(done) {
			s = new server.UnhangoutServer();
			s.on("inited", done);
			s.init({"transport":"file", "level":"debug", "GOOGLE_CLIENT_ID":true, "GOOGLE_CLIENT_SECRET":true});
		});

		afterEach(function(done) {
            common.standardShutdown(done, s);
        });
		
		it("#start should emit 'started' message when complete", function(done) {
			s.on("started", done);
			s.start();
		});
	});
	
	
	describe('routes (unauthenticated)', function() {
		beforeEach(common.standardSetup);
		afterEach(common.standardShutdown);
		
		describe("GET /", function() {
			it('should return without error', function(done) {
				request('http://localhost:7777/').end(function(res) {
					should.exist(res);
					res.status.should.equal(200);
					done();
				});
			});
		});
		
		describe("GET /event/:id", function() {
			it('should redirect to authentication, if unauthenticated', function(done) {
				request('http://localhost:7777/event/0')
				.redirects(0)
				.end(function(res) {
					res.status.should.equal(302);
					res.header['location'].should.equal("/auth/google");
					done();
				});
			});
		});
	});
	
	describe('routes (authenticated)', function() {
		beforeEach(common.mockSetup());
		afterEach(common.standardShutdown);
		
		describe("GET /event/:id", function() {
			it('should allow connections without redirection', function(done) {
				request('http://localhost:7777/event/1')
				.end(function(res) {
					res.status.should.equal(200);
					done();
				});				
			});
		});
	});

	describe('POST /subscribe', function() {
		beforeEach(common.mockSetup());
		afterEach(common.standardShutdown);

		it('should accept email addresses', function(done) {
			request.post('http://localhost:7777/subscribe')
			.send("email=email@example.com")
			.end(function(res) {
				res.status.should.equal(200);

				common.server.redis.lrange("global:subscriptions", -1, 1, function(err, res) {
					if(res=="email@example.com") {
						done();
					}
				});
			});
		});
	});


	describe('GET /h/:code', function(){
		beforeEach(common.mockSetup(false));
		afterEach(common.standardShutdown);

		it('should direct to the landing page when there is no code', function(done){
			request.get('http://localhost:7777/h/')
				.end(function(res){
					res.status.should.equal(200);
					done();
				});
		});

		it('if :code is new, it should create a new session on the server', function(done){
			request.get('http://localhost:7777/h/' + Math.floor(Math.random()*100000))
				.redirects(0)
				.end(function(res){
					res.status.should.equal(302);
					common.server.permalinkSessions.length.should.equal(1);
					done();
				});
		});

		it('if :code is active, multiple requests only create one session', function(done){
			request.get('http://localhost:7777/h/test')
				.redirects(0)
				.end(function(res){
					res.status.should.equal(302);
					common.server.permalinkSessions.length.should.equal(1);
					request.get('http://localhost:7777/h/test')
						.end(function(res){
							res.status.should.equal(200);
							common.server.permalinkSessions.length.should.equal(1);
							done();
						});
				});
		});

		it('if :code is new, it should present the form only for first visitor', function(done){
			request.get('http://localhost:7777/h/test')
				.end(function(res){
					res.text.indexOf('<input').should.not.equal(-1);
					request.get('http://localhost:7777/h/test')
						.end(function(res){
							res.text.indexOf('<input').should.equal(-1);
							done();
						});
				});
		});
	});

	describe('POST /h/admin/:code', function(){
		beforeEach(common.mockSetup(false, function(done){
			request.get('http://localhost:7777/h/test')
				.end(function(res) {
					res.status.should.equal(200);
					done();
				});
		}));

		afterEach(common.standardShutdown);

		it('should reject requests without a valid creation key in the request body', function(done){
			var session = common.server.permalinkSessions[0];
			request.post('http://localhost:7777/h/admin/test')
				.send({creationKey: 'wrong1', title: 'migrate title', description: 'something cool'})
				.end(function(res){
					res.status.should.equal(403);
					done();
				});
		});

		it('should update session title and description when valid creation key is present', function(done){
			var session = common.server.permalinkSessions.at(0);
			request.post('http://localhost:7777/h/admin/test')
				.send({creationKey: session.get('creationKey'), title: 'migrate title', description: 'something cool'})
				.end(function(res){
					res.status.should.equal(200);
					session.get('title').should.equal('migrate title');
					session.get('description').should.equal('something cool');
					done();
				});
		});
	});

	describe('POST /session/hangout/:id', function() {
		beforeEach(common.mockSetup(false, function(done) {
				// we need to start one of the sessions so it has a valid session key for any of this stuff to work.
				session = common.server.events.at(0).get("sessions").at(0);
				done();
			}));

		afterEach(common.standardShutdown);

		it('should handle loaded properly', function(done) {
			var fakeUrl = "http://plus.google.com/hangout/_/abslkjasdlfkjasdf";

			request.post('http://localhost:7777/session/hangout/' + session.get("session-key"))
				.send("type=loaded&url=" + encodeURIComponent(fakeUrl))
				.end(function(res) {
					res.status.should.equal(200);

					// this indexOf check is because the actual set url has a bunch of extra
					// url get params in it (like the hangout app gid, and startup params) 
					// so we just make sure that it STARTS with our string.
					session.get("hangout-url").indexOf(fakeUrl).should.equal(0);
					done();
				});
		});



		it('should handle participants properly', function(done) {
			request.post('http://localhost:7777/session/hangout/' + session.get("session-key"))
				.send({type:"participants", participants:[{person:{id:1}}, {person:{id:2}}]})
				.end(function(res) {
					res.status.should.equal(200);

					// this indexOf check is because the actual set url has a bunch of extra
					// url get params in it (like the hangout app gid, and startup params) 
					// so we just make sure that it STARTS with our string.
					session.getNumConnectedParticipants().should.equal(2);
					done();
				});
		});

		it('should handle heartbeat properly', function(done) {
			request.post('http://localhost:7777/session/hangout/' + session.get("session-key"))
				.send({type:"heartbeat", from:1213141235})
				.end(function(res) {
					res.status.should.equal(200);

					session.get("last-heartbeat").should.not.equal(null);
					done();
				});
		});

		it('should ignore requests without an id in the url', function(done) {
			request.post('http://localhost:7777/session/hangout/') // <--- note missing session-key in url
				.send({type:"heartbeat", from:1213141235})
				.end(function(res) {
					res.status.should.equal(404);
					done();
				});
		});

		it('should ignore requests without a type in the body', function(done) {
			request.post('http://localhost:7777/session/hangout/' + session.get("session-key"))
				.send({from:1213141235})
				.end(function(res) {
					res.status.should.equal(400);
					done();
				});

		});

		it('should ignore requests for sessions that haven\'t started yet / have invalid session-keys', function(done) {
			request.post('http://localhost:7777/session/hangout/' + "abe283917cd692387162bea283") // <--- note random session key
				.send({type:"heartbeat", from:1213141235})
				.end(function(res) {
					res.status.should.equal(400);
					done();
				});
		});
	});
	
	describe('sock (mock)', function() {
		beforeEach(common.mockSetup());
		afterEach(common.standardShutdown);

		it('should accept a connection at /sock', function(done) {
			var sock = sock_client.create("http://localhost:7777/sock");
			sock.on("connection", done);
		});
		
		it('should consider the socket unauthenticated before an AUTH message', function(done) {
			var sock = sock_client.create("http://localhost:7777/sock");
			sock.on("connection", function() {
				var socketsList = _.values(common.server.unauthenticatedSockets);
				socketsList.length.should.equal(1);
				socketsList[0].authenticated.should.equal(false);
				done();
			});
		});
		
		it('should reject a bad authorization key', function(done) {
			var sock = sock_client.create("http://localhost:7777/sock");
			sock.on("data", function(message) {
				var msg = JSON.parse(message);
				
				if(msg.type=="auth-err") {
					done();
				}
			});
			
			sock.on("connection", function() {
				sock.write(JSON.stringify({type:"auth", args:{key:"abe027d9c910236af", id:"0"}}));
			});	
		});
		
		it('should reject a good authorization key for the wrong id', function(done) {
			var sock = sock_client.create("http://localhost:7777/sock");
			sock.on("data", function(message) {
				var msg = JSON.parse(message);
				
				if(msg.type=="auth-err") {
					done();
				}
			});
			
			sock.on("connection", function() {
				var user = s.users.at(0);
				sock.write(JSON.stringify({type:"auth", args:{key:user.getSockKey(), id:"1"}}));
			});	
		});
		
		it('should accept a good authorization key', function(done) {
			var sock = sock_client.create("http://localhost:7777/sock");
			sock.on("data", function(message) {
				var msg = JSON.parse(message);
				
				if(msg.type=="auth-ack") {
					done();
				}
			});
			
			sock.on("connection", function() {
				var user = common.server.users.at(0);
				sock.write(JSON.stringify({type:"auth", args:{key:user.getSockKey(), id:user.id}}));
			});	
		});
		
		it('should trigger a disconnect event when closing the socket', function(done) {
			var sock = sock_client.create("http://localhost:7777/sock");
			sock.on("data", function(message) {
				var msg = JSON.parse(message);
				
				if(msg.type=="auth-ack") {
					sock.close();
				}
			});
			
			sock.on("connection", function() {
				var user = common.server.users.at(0);
				
				user.on("disconnect", done);
				
				sock.write(JSON.stringify({type:"auth", args:{key:user.getSockKey(), id:user.id}}));
			});	
		});
		
		describe("JOIN", function() {
			beforeEach(function(done) {
				sock = sock_client.create("http://localhost:7777/sock");
				sock.once("data", function(message) {
					var msg = JSON.parse(message);

					if(msg.type=="auth-ack") {
						done();
					}
				});

				sock.on("connection", function() {
					var user = common.server.users.at(0);
					sock.write(JSON.stringify({type:"auth", args:{key:user.getSockKey(), id:user.id}}));
				});	
			});
			
			it("should accept a join message with a valid event id", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="join-ack") {
						common.server.events.get(1).numUsersConnected().should.equal(1);
						done();
					}
				});
				
				sock.write(JSON.stringify({type:"join", args:{id:1}}));
			});
			
			it("should reject a join message with an invalid event id", function(done) {
				sock.once("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="join-err") {
						done();
					}
				});
												// 0 is not a valid event id in seeds
				sock.write(JSON.stringify({type:"join", args:{id:0}}));
			});
			
		});
		

		describe("CREATE-SESSION", function() {
			beforeEach(joinEventSetup);

			it("should accept create session messages", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);

					if(msg.type=="create-session-ack") {
						done();
					} else if(msg.type=="create-session-err") {
						should.fail();
					}
				});

				common.server.users.at(0).set("admin", true);
				
				sock.write(JSON.stringify({type:"create-session", args:{title: "New Session", description:"This is a description."}}));
			});

			it("should reject messages from non-admins", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="create-session-ack") {
						should.fail();
					} else if(msg.type=="create-session-err") {
						done();
					}
				});
				
				sock.write(JSON.stringify({type:"create-session", args:{title: "New Session", description:"This is a description."}}));
			});

			it("should reject create session messages without name", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);

					if(msg.type=="create-session-ack") {
						should.fail();
					} else if(msg.type=="create-session-err") {
						done();
					}
				});

				common.server.users.at(0).set("admin", true);
				
				sock.write(JSON.stringify({type:"create-session", args:{title: "New Session"}}));
			});

			it("should reject create session messages without description", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);

					if(msg.type=="create-session-ack") {
					} else if(msg.type=="create-session-err") {
						done();
					}
				});

				common.server.users.at(0).set("admin", true);
				
				sock.write(JSON.stringify({type:"create-session", args:{description:"This is a description."}}));
			});

			it("should broadcast a create-session message to clients", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);

					// note create-session not create-session-ack
					if(msg.type=="create-session") {
						msg.args.title.should.equal("New Session");
						msg.args.description.should.equal("This is a description.");
						done();
					} else if(msg.type=="create-session-err") {
						should.fail();
					}
				});

				common.server.users.at(0).set("admin", true);
				
				sock.write(JSON.stringify({type:"create-session", args:{title: "New Session", description:"This is a description."}}));
			});
		});
		
		describe("OPEN/CLOSE SESSIONS", function() {
			beforeEach(joinEventSetup);

			it("should accept open messages from admins", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="open-sessions-ack") {
						common.server.events.get(1).sessionsOpen().should.be.true
						done();
					} else if(msg.type=="open-sessions-err") {
						should.fail();
					}
				});
				
				common.server.users.at(0).set("admin", true);
				sock.write(JSON.stringify({type:"open-sessions", args:{}}));
			});
			
			it("should generate messages to everyone in the event on open sessions", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="open-sessions") {
						done();
					} else if(msg.type=="open-sessions-err") {
						should.fail();
					}
				});

				common.server.users.at(0).set("admin", true);
				sock.write(JSON.stringify({type:"open-sessions", args:{}}));
			});

			it("should accept close messages from admins", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="close-sessions-ack") {
						common.server.events.get(1).sessionsOpen().should.be.false
						done();
					} else if(msg.type=="close-sessions-err") {
						should.fail();
					}
				});
				
				common.server.users.at(0).set("admin", true);
				sock.write(JSON.stringify({type:"close-sessions", args:{}}));
			});
			
			it("should generate messages to everyone in the event on close sessions", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="close-sessions") {
						done();
					} else if(msg.type=="close-sessions-err") {
						should.fail();
					}
				});

				common.server.users.at(0).set("admin", true);
				sock.write(JSON.stringify({type:"close-sessions", args:{}}));
			});


		})

		describe("EMBED", function() {
			beforeEach(joinEventSetup);
			
			it("should reject embed messages from non-admins", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="embed-ack") {
						should.fail();
					} else if(msg.type=="embed-err") {
						done();
					}
				});
				
				sock.write(JSON.stringify({type:"embed", args:{ydId:"QrsIICQ1eg8"}}));
			});
			
			
			it("should reject embed messages without a ytId argument", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="embed-ack") {
						should.fail();
					} else if(msg.type=="embed-err") {
						done();
					}
				});
				
				common.server.users.at(0).set("admin", true);
				
				sock.write(JSON.stringify({type:"embed", args:{}}));
			});
			
			
			it("should accept embed messages from admins", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="embed-ack") {
						done();
					} else if(msg.type=="embed-err") {
						should.fail();
					}
				});
				
				common.server.users.at(0).set("admin", true);
				
				sock.write(JSON.stringify({type:"embed", args:{ytId:"QrsIICQ1eg8"}}));
			});
			
			it("should generate messages to everyone in the event on embed", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="embed") {
						msg.args.should.have.keys("ytId");
						msg.args.ytId.should.equal("QrsIICQ1eg8");
						done();
					} else if(msg.type=="embed-err") {
						should.fail();
					}
				});
				
				common.server.users.at(0).set("admin", true);
				
				sock.write(JSON.stringify({type:"embed", args:{ytId:"QrsIICQ1eg8"}}));
			});	
		});

		describe("CHAT", function() {
			beforeEach(joinEventSetup);
			
			it("should reject a chat message without text argument", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="chat-ack") {
						should.fail();
					} else if(msg.type=="chat-err") {
						done();
					}
				});
				
				sock.write(JSON.stringify({type:"chat", args:{}}));
			});
			
			it("should accept a chat message with proper arguments", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="chat-ack") {
						done();
					} else if(msg.type=="chat-err") {
						should.fail();
					}
				});				
				sock.write(JSON.stringify({type:"chat", args:{text:"hello world"}}));
			});
			
			
		//  These two tests should in principle work, but the mock authentication scheme we're using
		//  doesn't seem to gracefully support having TWO mock users. So, putting these tests on hold for now
		//  until we can really create a second user to test against.
//			it("should broadcast a chat message to everyone in event", function(done) {
//				connectNewSock(function(altSock) {
//					// at this point we have two sockets; sock and altSock. Both are connected to event.
//					altSock.on("data", function(message) {
//
//						var msg = JSON.parse(message);
//						if(msg.type=="chat") {
//							msg.args.should.have.keys("text", "user", "time");
//							msg.args.text.should.equal("hello world");
//							done();
//						}
//					});
//					
//					sock.write(JSON.stringify({type:"chat", args:{text:"hello world"}}));
//				});
//			});
//			
//			it("should not send the chat message to users in other events", function(done) {
//				done();
//			});
		});
		
	});
})
