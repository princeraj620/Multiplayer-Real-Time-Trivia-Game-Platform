// Break things on purpose: stop, kill, pause and restart parts of the system.
// By default this uses Docker Compose. Set CTL to use something else, e.g.
//   CTL="./my-ctl.sh {action} {name}"
import { execSync } from 'node:child_process';

const TEMPLATE = process.env.CTL || 'docker compose {action} {name}';

/** action: kill | stop | start | pause | unpause.  name: a compose service, e.g. engine1, gateway2, etcd3 */
export function ctl(action, name) {
  const cmd = TEMPLATE.replace('{action}', action).replace('{name}', name);
  execSync(cmd, { stdio: 'ignore' });
}

/** "engine-2" (instance id) -> "engine2" (compose service name) */
export const serviceOf = (instance) => instance.replace('-', '');
