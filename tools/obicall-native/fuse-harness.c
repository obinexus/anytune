/*
 * The native side of AnyTune's scalar-fusion conformance (A8): a tool that calls Obicall's own obicall_static_fuse_1d, from the staged obicall.dll, and
 * nothing else. It is a test instrument — never part of the application, never loaded by the browser.
 *
 * stdin, one case a line:  <count> <mean_0> … <mean_{count-1}> <variance_0> … <variance_{count-1}>
 *                          every double as the 16 hex digits of its IEEE-754 bits, so that no decimal rounding stands between the two implementations
 * stdout, one line a case: <status> <mean bits> <variance bits>   — or <status> - -  when the status is not OBICALL_OK (Obicall writes no output then)
 *                          <status> is obicall_status_string(status)
 *
 * Build: tools/obicall-native/build.sh (the UCRT64 GCC that built Obicall, against the staged include/ and lib/).
 */
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "obicall/estimator.h"
#include "obicall/status.h"

#define MAX_COUNT 64

static double from_bits(uint64_t bits) {
    double value;
    memcpy(&value, &bits, sizeof value);
    return value;
}

static uint64_t to_bits(double value) {
    uint64_t bits;
    memcpy(&bits, &value, sizeof bits);
    return bits;
}

int main(void) {
    unsigned count;
    while (scanf("%u", &count) == 1) {
        if (count > MAX_COUNT) {
            fprintf(stderr, "fuse-harness: a case of %u values is over %d\n", count, MAX_COUNT);
            return 2;
        }
        double means[MAX_COUNT], variances[MAX_COUNT];
        for (unsigned i = 0; i < 2 * count; ++i) {
            uint64_t bits;
            if (scanf("%" SCNx64, &bits) != 1) {
                fprintf(stderr, "fuse-harness: a case ends early\n");
                return 2;
            }
            if (i < count) means[i] = from_bits(bits);
            else variances[i - count] = from_bits(bits);
        }
        double mean = 0.0, variance = 0.0;
        obicall_status_t status = obicall_static_fuse_1d(means, variances, (uint32_t)count, &mean, &variance);
        if (status == OBICALL_OK) printf("%s %016" PRIx64 " %016" PRIx64 "\n", obicall_status_string(status), to_bits(mean), to_bits(variance));
        else printf("%s - -\n", obicall_status_string(status));
    }
    return 0;
}
