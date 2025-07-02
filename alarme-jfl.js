// alarme-jfl.js
module.exports = function(RED) {
    "use strict";
    
    function AlarmeJFLNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const net = require('net');
        let server = null;
        
        // Configurações
        const port = parseInt(config.port) || 9999;
        const host = config.host || '0.0.0.0';
        
        // Função para calcular checksum XOR
        function calculateChecksum(buffer) {
            let checksum = 0;
            for (let i = 0; i < buffer.length; i++) {
                checksum ^= buffer[i];
            }
            return checksum;
        }
        
        // Criar servidor TCP
        try {
            server = net.createServer((socket) => {
                node.status({fill:"green", shape:"dot", text:`conectado ${socket.remoteAddress}`});
                
                socket.on('data', (data) => {
                    node.log(`Dados recebidos: ${data.length} bytes - ${data.toString('hex')}`);
                    
                    // Verificar se tem exatamente 5 bytes
                    if (data.length === 5) {
                        // Criar mensagem base
                        const baseMessage = Buffer.from([0x7B, 0x06, 0x01, 0x40, 0x01]);
                        
                        // Calcular checksum
                        const checksum = calculateChecksum(baseMessage);
                        
                        // Criar mensagem completa
                        const responseMessage = Buffer.concat([baseMessage, Buffer.from([checksum])]);
                        
                        // Enviar resposta
                        socket.write(responseMessage, (err) => {
                            if (err) {
                                node.error(`Erro ao enviar resposta: ${err.message}`);
                            } else {
                                node.log(`Resposta enviada: ${responseMessage.toString('hex')}`);
                            }
                        });
                        
                        // Enviar dados para saída do nó
                        const msg = {
                            payload: {
                                received: data.toString('hex'),
                                sent: responseMessage.toString('hex'),
                                receivedBytes: data.length,
                                sentBytes: responseMessage.length,
                                timestamp: new Date().toISOString(),
                                clientIP: socket.remoteAddress
                            }
                        };
                        node.send(msg);
                        
                        node.status({fill:"blue", shape:"dot", text:"resposta enviada"});
                        
                    } else {
                        node.warn(`Tamanho incorreto: ${data.length} bytes (esperado: 5)`);
                        node.status({fill:"yellow", shape:"ring", text:`pacote ${data.length} bytes`});
                    }
                });
                
                socket.on('close', () => {
                    node.log('Cliente desconectado');
                    node.status({fill:"yellow", shape:"ring", text:"aguardando"});
                });
                
                socket.on('error', (err) => {
                    node.error(`Erro no socket: ${err.message}`);
                    node.status({fill:"red", shape:"ring", text:"erro socket"});
                });
            });
            
            server.listen(port, host, () => {
                node.log(`Servidor iniciado em ${host}:${port}`);
                node.status({fill:"yellow", shape:"ring", text:`escutando :${port}`});
            });
            
            server.on('error', (err) => {
                node.error(`Erro no servidor: ${err.message}`);
                node.status({fill:"red", shape:"ring", text:"erro servidor"});
            });
            
        } catch (err) {
            node.error(`Erro ao criar servidor: ${err.message}`);
            node.status({fill:"red", shape:"ring", text:"erro init"});
        }
        
        // Cleanup
        node.on('close', (done) => {
            if (server) {
                server.close(() => {
                    node.log('Servidor fechado');
                    done();
                });
            } else {
                done();
            }
        });
    }
    
    RED.nodes.registerType("alarme-jfl", AlarmeJFLNode);
};
