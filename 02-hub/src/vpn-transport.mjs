// Shared by node configuration and Happ/Xray subscriptions.
export function stabilityMode(value='stable') {
  if(!['stable','system'].includes(value))throw Object.assign(Error('Неизвестный режим соединения'),{status:400});
  return value;
}
export function applyTCPStability(stream,connection={}, {server=false,bbr=false}={}) {
  if(stream.network==='hysteria'||stabilityMode(connection.stability)==='system')return stream;
  stream.sockopt={...stream.sockopt,tcpKeepAliveIdle:45,tcpKeepAliveInterval:15,tcpUserTimeout:60000,
    ...(server&&bbr?{tcpcongestion:'bbr'}:{})};
  // A shorter interval can cause GOAWAY on directly connected gRPC servers.
  if(stream.network==='grpc'&&!server)Object.assign(stream.grpcSettings,{idle_timeout:60,health_check_timeout:20,permit_without_stream:false});
  return stream;
}
