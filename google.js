module.exports = function(RED) {

    function encodeAPI(name, version) {
        return name + ':' + version;
    }

    function decodeAPI(api) {
        var a = api.split(':', 2);
        return {
            name: a[0],
            version: a[1]
        };
    }

    const {google} = require('googleapis');
    const discovery = google.discovery('v1');
    const util = require('util');

    RED.httpAdmin.get('/google/apis', function(req, res) {
        discovery.apis.list({
            fields: "items(name,version)"
        }, function(err, data) {
            var response = [];
            data.data.items.forEach(function(v) {
                response.push(encodeAPI(v.name, v.version));
            });
            response.sort();
            res.json(response);
        });
    });

    RED.httpAdmin.get('/google/apis/:api/info', function(req, res) {

        var api = decodeAPI(req.params.api);

        discovery.apis.getRest({
            api: api.name,
            version: api.version,
            fields: "auth,methods,resources"
        }, function(err, data) {

            if (err) {
              return res.status(500).json(err);
            }

            var response = {
                operations: [],
                scopes: []
            };

            function processResources(d, parent) {
                var prefix = parent ? parent + '.' : '';
                if (d.methods) {
                    Object.keys(d.methods).forEach(function(k) {
                        response.operations.push(prefix + k);
                    });
                }
                if (d.resources) {
                    Object.keys(d.resources).forEach(function(k) {
                        processResources(d.resources[k], prefix + k);
                    });
                }
            }

            processResources(data.data);

            response.operations.sort();
            response.scopes = Object.keys(data.data.auth.oauth2.scopes);

            res.json(response);

        });
    });

    RED.httpAdmin.get('/google/authorizeUrl/:node', function(req, res) {
        var config_node = RED.nodes.getNode(req.params.node);

        if(config_node){
            res.send('<a href="' + config_node.getAuthorizeUrl() + '" target="_blank">OAuth2 Authorization Page</a>');
        }
    });

    RED.httpNode.get('/google/oauth2callback', function(req, res) {
        var config_node = RED.nodes.getNode(req.query.state);

        if(config_node){
            config_node.processAuthCode(req.query.code);
            res.send("OAuth2 Authorization Complete. This browser tab is no longer needed.");
        } else {
            return res.status(404).json(req.query.state + ' is an incorrect state');
        }
        
    });


    function GoogleConnectionNode(config){
        var serviceauth = null;
        var oauth2Client = null;
        RED.nodes.createNode(this, config);
        this.service_key = JSON.parse(config.service_key);
        this.scopes = config.scopes;

        this.getServiceAuth = function() {
          if(!serviceauth) {
            serviceauth = new google.auth.JWT(
                this.service_key.client_email,
                null,
                this.service_key.private_key,
                this.scopes.split('\n'),
                null
            );
          }
          return serviceauth;
        }

        this.getOAuth2Client = function(){
            if(!oauth2Client){
                oauth2Client = new google.auth.OAuth2(
                    config.oauth2_client_id,
                    config.oauth2_client_secret,
                    config.oauth2_callback_root+'/google/oauth2callback'
                );

                oauth2Client.setCredentials({
                    refresh_token: this.context().get('oauth2_refresh_token')
                });

                oauth2Client.on('tokens', (tokens) => {

                    this.log(util.inspect(tokens));

                    if (tokens.refresh_token) {
                        this.context().set('oauth2_refresh_token', tokens.refresh_token);
                        this.log("Got new OAuth2 refresh token")   
                    }
                });
            }
            return oauth2Client;
        }

        this.getAPIAuth = function(){
            return ""
        }

        this.getAuth = function(){
            switch(config.auth_type){
                case "oauth2":
                    return this.getOAuth2Client();
                case "service":
                    return this.getServiceAuth();
                case "api":
                    return this.getAPIAuth();
            }
        }

        this.getAuthorizeUrl = function(){
            return this.getOAuth2Client().generateAuthUrl({
                access_type: 'offline',
                scope: this.scopes.split('\n'),
                prompt: "consent",
                state: encodeURIComponent(this.id)
            });
        }

        this.processAuthCode = async function(authCode){

            const {tokens} = await this.getOAuth2Client().getToken(authCode);

            this.getOAuth2Client().setCredentials(tokens);

        }
    }

    function GoogleNode(config) {

        RED.nodes.createNode(this, config);
        var node = this;
        node.config = RED.nodes.getNode(config.google);
        node.api = config.api;
        node.operation = config.operation;
        node.scopes = config.scopes;

        node.on('input', function(msg) {

            node.status({
                fill: 'blue',
                shape: 'dot',
                text: 'pending'
            });

            // var jwt = new google.auth.JWT(
            //     node.config.client_email,
            //     null,
            //     node.config.private_key,
            //     node.scopes.split('\n'),
            //     null
            // );

            var auth = node.config.getAuth();

            var api = decodeAPI(node.api);
            api = google[api.name]({
                version: api.version,
                auth: auth
            });

            var props = node.operation.split('.');
            var operation = api;
            props.forEach(function(val) {
                operation = operation[val];
            });

            operation(msg.payload, function(err, res) {

                if (err) {
                    node.status({
                        fill: 'red',
                        shape: 'dot',
                        text: 'error'
                    });
                    node.error(err, msg);
                    return;
                }

                node.status({
                    fill: 'yellow',
                    shape: 'dot',
                    text: 'success'
                });

                msg.payload = res;

                node.send(msg);
            });

        });
    }

    RED.nodes.registerType("google-conn", GoogleConnectionNode);
    RED.nodes.registerType("google", GoogleNode);

};
