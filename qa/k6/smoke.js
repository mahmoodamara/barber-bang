import http from 'k6/http';
import { sleep, check } from 'k6';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
  },
};

const baseUrl = __ENV.BASE_URL || 'http://localhost:4000';

export default function () {
  const res = http.get(`${baseUrl}/health`);
  check(res, {
    'health 200': (r) => r.status === 200,
  });
  sleep(1);
}
