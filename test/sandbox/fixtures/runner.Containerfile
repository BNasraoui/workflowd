FROM workflowd-sandbox-tooling:fixture
USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server python3 iptables \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd && passwd -d runner \
    && mkdir -p /home/runner/.ssh && chmod 700 /home/runner/.ssh \
    && chown -R runner:runner /home/runner /workspace \
    && chown runner:runner /etc/ssh/ssh_host_ed25519_key \
    && printf '%s\n' 'UsePAM no' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' \
       'HostKey /etc/ssh/ssh_host_ed25519_key' 'PidFile /home/runner/sshd.pid' > /etc/ssh/sshd_config \
    && mv -f /usr/local/bin/container-use /usr/local/bin/container-use-real \
    && printf '%s\n' '#!/bin/sh' 'cd /workspace/repository' \
       'exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/runner _EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://engine:1234 /usr/local/bin/container-use-real "$@"' \
       > /usr/local/bin/container-use \
    && chmod 755 /usr/local/bin/container-use
USER runner
RUN git init -b main && printf 'fixture\n' > README && git add README && git commit -m fixture
CMD ["/usr/sbin/sshd", "-D", "-e"]
