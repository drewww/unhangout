var server = require('../lib/unhangout-server'),
	should = require('should'),
	_ = require('underscore')._,
	sock_client = require('sockjs-client'),
	request = require('superagent'),
	redis = require('redis').createClient();
	seed = require('../bin/seed.js');

var s;
var sock;
var session;

var standardSetup = function(done) {
	s = new server.UnhangoutServer();
	s.on("inited", function() {s.start()});
	s.on("started", done);
	
	seed.run(1, redis, function() {
		s.init({"transport":"file", "level":"debug", "GOOGLE_CLIENT_ID":true, "GOOGLE_CLIENT_SECRET":true, "REDIS_DB":1});		
	});
}

var mockSetup = function(admin, callback) {
	return function(done) {
		s = new server.UnhangoutServer();
		s.on("inited", function() {s.start()});
		s.on("started", function() {
			if(callback) {
				callback(done);
			} else {
				done();
			}
		});
		
		if(_.isUndefined(admin)) {
			admin = false;
		}

		seed.run(1, redis, function() {
			s.init({"transport":"file", "level":"debug", "GOOGLE_CLIENT_ID":true, "GOOGLE_CLIENT_SECRET":true, "REDIS_DB":1, "mock-auth":true, "mock-auth-admin":admin});		
		});
	}
}


var standardShutdown = function(done) {
	s.on("stopped", function() {
		s.on("destroyed", done);
		s.destroy();
	});
	s.stop();
};

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
		var user = s.users.at(s.users.length-1);
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

		afterEach(standardShutdown);
		
		it("#start should emit 'started' message when complete", function(done) {
			s.on("started", done);
			s.start();
		});
	});
	
	
	describe('routes (unauthenticated)', function() {
		beforeEach(standardSetup);
		afterEach(standardShutdown);
		
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
		beforeEach(mockSetup());
		afterEach(standardShutdown);
		
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
		beforeEach(mockSetup());
		afterEach(standardShutdown);

		it('should accept email addresses', function(done) {
			request.post('http://localhost:7777/subscribe')
			.send("email=email@example.com")
			.end(function(res) {
				res.status.should.equal(200);

				redis.lrange("global:subscriptions", -1, 1, function(err, res) {
					if(res=="email@example.com") {
						done();
					}
				});
			});
		});
	});

	describe('POST /session/hangout/:id', function() {
		beforeEach(mockSetup(false, function(done) {
				// we need to start one of the sessions so it has a valid session key for any of this stuff to work.
				session = s.events.at(0).get("sessions").at(0);

				session.start();

				done();
			}));

		afterEach(standardShutdown);

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
		beforeEach(mockSetup());
		afterEach(standardShutdown);

		it('should accept a connection at /sock', function(done) {
			var sock = sock_client.create("http://localhost:7777/sock");
			sock.on("connection", done);
		});
		
		it('should consider the socket unauthenticated before an AUTH message', function(done) {
			var sock = sock_client.create("http://localhost:7777/sock");
			sock.on("connection", function() {
				var socketsList = _.values(s.unauthenticatedSockets);
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
				var user = s.users.at(0);
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
				var user = s.users.at(0);
				
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
					var user = s.users.at(0);
					sock.write(JSON.stringify({type:"auth", args:{key:user.getSockKey(), id:user.id}}));
				});	
			});
			
			it("should accept a join message with a valid event id", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="join-ack") {
						s.events.get(1).numUsersConnected().should.equal(1);
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
			
			it("should reject an ATTEND message before a join");
		});
		
		describe("ATTEND", function() {
			beforeEach(joinEventSetup);
			
			it("should accept an ATTEND request with a valid session id (part of event)", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="attend-ack") {
						done();
					} else if(msg.type=="attend-err") {
						should.fail();
					}
				});

				sock.write(JSON.stringify({type:"attend", args:{id:1}}));
			});
						
			it('should reject an ATTEND request with a valid session id (not part of event)', function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="attend-ack") {
						should.fail();
					} else if(msg.type=="attend-err") {
						done();
					}
				});

				sock.write(JSON.stringify({type:"attend", args:{id:28}}));
			});
			
			it('should reject an ATTEND request with an invalid session id', function(done) {
				sock.once("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="attend-ack") {
						should.fail();
					} else if(msg.type=="attend-err") {
						done();
					}
				});

				sock.write(JSON.stringify({type:"attend", args:{id:100}}));
			});
			
			it('should increment attendee count', function(done) {
				var session = s.events.get(1).get("sessions").get(1);
				session.numAttendees().should.equal(0);
				
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="attend-ack") {
						session.numAttendees().should.equal(1);
						done();
					} else if(msg.type=="attend-err") {
						should.fail();
					}
				});

				sock.write(JSON.stringify({type:"attend", args:{id:1}}));	
			});
			
			it('should generate a message to clients joined to that event', function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="attend") {
						msg.args.should.have.keys("id", "user");
						done();
					} else if(msg.type=="attend-err") {
						should.fail();
					}
				});

				sock.write(JSON.stringify({type:"attend", args:{id:1}}));				
			});
		});
		
		describe("UNATTEND", function() {
			beforeEach(joinEventSetup);
			
			it("should accept an UNATTEND request with the user.id of an attending user", function(done) {
				// manipulate internal state to do an attend.
				var user = s.users.at(0);
				var event = s.events.get(1);
				var session = event.get("sessions").at(0);
				
				session.addAttendee(user);
				
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					
					if(msg.type=="unattend-ack") {
						done();
					} else if(msg.type=="unattend-err") {
						should.fail("unattend-err");
					}
				});
				
				sock.write(JSON.stringify({type:"unattend", args:{id:session.id}}));
			});
			
			it("should reject an UNATTEND request if that user.id is not attending", function(done) {
				// manipulate internal state to do an attend.
				var user = s.users.at(0);
				var event = s.events.get(1);
				var session = event.get("sessions").at(0);
				
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					
					if(msg.type=="unattend-ack") {
						should.fail("unattend-err");
					} else if(msg.type=="unattend-err") {
						done();
					}
				});
				
				sock.write(JSON.stringify({type:"unattend", args:{id:session.id}}));				
			});
			
			it("should send an UNATTEND message to all connected users in that event", function(done) {
				var user = s.users.at(0);
				var event = s.events.get(1);
				var session = event.get("sessions").at(0);
				
				session.addAttendee(user);
				
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					
					if(msg.type=="unattend") {
						done();
					} else if(msg.type=="unattend-err") {
						should.fail("unattend-err");
					}
				});
				
				sock.write(JSON.stringify({type:"unattend", args:{id:session.id}}));
			});			
		});
		
		describe("START/STOP", function() {
			beforeEach(joinEventSetup);
			
			it("should reject start messages from non-admins", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="start-ack") {
						should.fail();
					} else if(msg.type=="start-err") {
						done();
					}
				});
				
				sock.write(JSON.stringify({type:"start", args:{id:s.events.get(1).get("sessions").at(0).id}}));
			});
			
			it("should accept start messages from admins", function(done) {
				sock.on("data", function(message) {
					var msg = JSON.parse(message);
					if(msg.type=="start-ack") {
						done();
					} else if(msg.type=="start-err") {
						should.fail();
					}
				});
				
				s.users.at(0).set("admin", true);
				
				sock.write(JSON.stringify({type:"start", args:{id:s.events.get(1).get("sessions").at(0).id}}));
			});

			it("should accept a stop-all message");
			it("should stop any running session, but not stop non-running sessions");
			it("should send stop messages for running sessions to clients");
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

				s.users.at(0).set("admin", true);
				
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

				s.users.at(0).set("admin", true);
				
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

				s.users.at(0).set("admin", true);
				
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

				s.users.at(0).set("admin", true);
				
				sock.write(JSON.stringify({type:"create-session", args:{title: "New Session", description:"This is a description."}}));
			});
		});
		
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
				
				s.users.at(0).set("admin", true);
				
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
				
				s.users.at(0).set("admin", true);
				
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
				
				s.users.at(0).set("admin", true);
				
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