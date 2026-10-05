FROM workflowd-sandbox-tooling:fixture
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd && useradd -m runner && passwd -d runner \
    && mkdir -p /home/runner/.ssh && chmod 700 /home/runner/.ssh \
    && chown -R runner:runner /home/runner /workspace
RUN mv -f /usr/local/bin/container-use /usr/local/bin/container-use-real \
    && printf '%s\n' '#!/bin/sh' 'cd /workspace/repository' 'exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/runner _EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://engine:1234 /usr/local/bin/container-use-real "$@"' > /usr/local/bin/container-use \
    && chmod 755 /usr/local/bin/container-use
USER runner
RUN git init -b main && printf 'fixture\n' > README && git add README && git commit -m fixture
USER root
CMD ["/usr/sbin/sshd", "-D", "-e"]
