const NUM_REQUESTS = 4;
const DELAY_MS = 200;

async function mockFetch(id: number) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(`Response ${id}`);
    }, DELAY_MS);
  });
}

async function runSequential() {
  const start = performance.now();
  for (let i = 0; i < NUM_REQUESTS; i++) {
    await mockFetch(i);
  }
  const end = performance.now();
  return end - start;
}

async function runParallel() {
  const start = performance.now();
  const promises = [];
  for (let i = 0; i < NUM_REQUESTS; i++) {
    promises.push(mockFetch(i));
  }
  await Promise.all(promises);
  const end = performance.now();
  return end - start;
}

async function main() {
  console.log("Benchmarking Sequential vs Promise.all");

  const seqTime = await runSequential();
  console.log(`Sequential time: ${seqTime.toFixed(2)}ms`);

  const parTime = await runParallel();
  console.log(`Parallel time: ${parTime.toFixed(2)}ms`);

  console.log(`Improvement: ${(seqTime / parTime).toFixed(2)}x faster`);
}

main().catch(console.error);
